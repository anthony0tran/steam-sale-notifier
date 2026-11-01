import { sendDiscordNotifications } from "./discord";
import { fetchSteamFreeGames, isTemporarilyFree } from "./steam";
import { getSeenGames, pruneSeenGames, saveSeenGames } from "./state";
import type { Env, SeenGames, SteamGame } from "./types";
import { errorMessage } from "./utils";

const VALIDATION_CONCURRENCY = 4;

export interface CheckDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CheckResult {
  gamesFound: number;
  candidates: number;
  notified: string[];
  notificationFailures: string[];
  validationFailures: string[];
}

/**
 * Validate new candidates. `undefined` means Steam could not be asked, so the
 * app is left unresolved and retried on a later run. Validation runs with
 * limited concurrency to stay polite to Steam.
 */
async function resolvePromotions(
  games: readonly SteamGame[],
  seen: SeenGames,
  now: number,
  fetchImpl: typeof fetch,
): Promise<{ validationFailures: string[] }> {
  const unresolved = games.filter((game) => {
    const entry = seen[game.appId];
    return entry === undefined || entry.free === undefined;
  });

  const validationFailures: string[] = [];

  await mapWithConcurrency(unresolved, VALIDATION_CONCURRENCY, async (game) => {
    let free: boolean | undefined;
    try {
      free = await isTemporarilyFree(game.appId, fetchImpl);
    } catch (cause) {
      validationFailures.push(game.appId);
      console.warn(`Could not validate Steam app ${game.appId}: ${errorMessage(cause)}`);
    }

    const entry = seen[game.appId] ?? { firstSeenAt: now, lastSeenAt: now };
    if (free !== undefined) {
      entry.free = free;
    }
    entry.lastSeenAt = now;
    seen[game.appId] = entry;
  });

  return { validationFailures };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const current = index;
      index++;
      if (current >= items.length) {
        return;
      }
      const item = items[current];
      if (item === undefined) {
        continue;
      }
      await fn(item);
    }
  });

  await Promise.all(runners);
}

/**
 * One scheduled check:
 *   1. Fetch current temporary free games from Steam.
 *   2. Validate candidates we have not priced yet.
 *   3. Notify for validated games that were never successfully announced.
 *   4. Mark successful notifications and persist pruned state.
 *
 * A Steam or KV failure throws before anything is saved, so the run can be
 * retried by the next cron tick without corrupting state.
 */
export async function runCheck(env: Env, deps: CheckDeps = {}): Promise<CheckResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now?.() ?? Date.now();

  const games = await fetchSteamFreeGames(fetchImpl);
  const seen = await getSeenGames(env, now);

  const { validationFailures } = await resolvePromotions(games, seen, now, fetchImpl);

  // Refresh lastSeenAt for every app still in the results so promotions that
  // end are eventually pruned and can be announced again later.
  for (const game of games) {
    const entry = seen[game.appId] ?? { firstSeenAt: now, lastSeenAt: now };
    entry.lastSeenAt = now;
    seen[game.appId] = entry;
  }

  const candidates = games.filter((game) => {
    const entry = seen[game.appId];
    return entry?.free === true && entry.notifiedAt === undefined;
  });

  let notified: string[] = [];
  let notificationFailures: string[] = [];

  if (candidates.length > 0) {
    const result = await sendDiscordNotifications(env, candidates, fetchImpl);
    notified = result.sentAppIds;
    notificationFailures = result.failedAppIds;

    for (const appId of notified) {
      const entry = seen[appId];
      if (entry) {
        entry.notifiedAt = now;
      }
    }
  }

  await saveSeenGames(env, pruneSeenGames(seen, now));

  const result: CheckResult = {
    gamesFound: games.length,
    candidates: candidates.length,
    notified,
    notificationFailures,
    validationFailures,
  };

  console.log(
    "Steam free games check complete",
    JSON.stringify({
      gamesFound: result.gamesFound,
      candidates: result.candidates,
      notified: result.notified.length,
      notificationFailures: result.notificationFailures.length,
      validationFailures: result.validationFailures.length,
    }),
  );

  return result;
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      await runCheck(env);
    } catch (cause) {
      console.error("Scheduled Steam free games check failed", errorMessage(cause));
      // Rethrow so the failure is visible in Cron metrics/alerts.
      throw cause;
    }
  },
} satisfies ExportedHandler<Env>;
