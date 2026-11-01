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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return jsonResponse({ ok: true, service: "steam-sale-notifier" });
    }

    if (url.pathname !== "/check") {
      return jsonResponse({ ok: false, error: "not found" }, 404);
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method not allowed" }, 405, {
        allow: "GET, POST",
      });
    }

    const token = env.MANUAL_TRIGGER_TOKEN;
    if (!token) {
      return jsonResponse(
        { ok: false, error: "MANUAL_TRIGGER_TOKEN is not configured" },
        503,
      );
    }

    if (!isAuthorized(request, token)) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }

    try {
      const result = await runCheck(env);
      return jsonResponse({ ok: true, ...result });
    } catch (cause) {
      console.error("Manual Steam free games check failed", errorMessage(cause));
      return jsonResponse({ ok: false, error: errorMessage(cause) }, 500);
    }
  },

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

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function isAuthorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization");
  if (!header) {
    return false;
  }

  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") {
    return false;
  }

  return timingSafeEqual(value, token);
}

/** Compare without early exit so the token check does not leak its prefix. */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let index = 0; index < maxLength; index++) {
    const aCode = index < a.length ? a.charCodeAt(index) : 0;
    const bCode = index < b.length ? b.charCodeAt(index) : 0;
    difference |= aCode ^ bCode;
  }

  return difference === 0;
}
