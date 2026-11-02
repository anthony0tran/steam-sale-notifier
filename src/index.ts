import { sendDiscordNotifications } from "./discord";
import { formatMention, mentionLabel, parseMentionTargets } from "./mentions";
import { fetchSteamFreeGames, getPromotionInfo } from "./steam";
import { fetchOwnedAppIds } from "./steam-library";
import { getSeenGames, isNotificationDue, pruneSeenGames, saveSeenGames } from "./state";
import type {
  Env,
  MentionTarget,
  PromotionInfo,
  SeenGames,
  SteamGame,
} from "./types";
import { errorMessage } from "./utils";

const VALIDATION_CONCURRENCY = 4;
const LIBRARY_CONCURRENCY = 2;

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
  /** Configured users whose library could not be read this run. */
  mentionFailures: string[];
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
    // Entries without `kind` predate DLC support; re-validate them once so
    // previously skipped DLCs (and their base game ids) are picked up.
    return entry === undefined || entry.free === undefined || entry.kind === undefined;
  });

  const validationFailures: string[] = [];

  await mapWithConcurrency(unresolved, VALIDATION_CONCURRENCY, async (game) => {
    let info: PromotionInfo | undefined;
    try {
      info = await getPromotionInfo(game.appId, fetchImpl);
    } catch (cause) {
      validationFailures.push(game.appId);
      console.warn(`Could not validate Steam app ${game.appId}: ${errorMessage(cause)}`);
    }

    const entry = seen[game.appId] ?? { firstSeenAt: now, lastSeenAt: now };
    if (info !== undefined) {
      entry.free = info.free;
      if (info.kind) {
        entry.kind = info.kind;
      } else {
        delete entry.kind;
      }
      if (info.baseAppId) {
        entry.baseAppId = info.baseAppId;
      } else {
        delete entry.baseAppId;
      }
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

interface MentionResolution {
  /** Candidates that should actually be posted. */
  games: SteamGame[];
  mentionsByAppId: Map<string, string[]>;
  mentionFailures: string[];
}

/**
 * Decide which candidates to post and who should be pinged.
 *
 * Regular games are always posted. Users who do not own the game are mentioned.
 *
 * DLC is only posted when at least one configured user owns its base game,
 * because the DLC is useless to everyone else. DLC ownership itself is not
 * exposed by Steam's owned-games endpoint, so the base game is the usable
 * signal. The confirmed base-game owners are mentioned.
 *
 * Each configured library is fetched at most once per run. A library that
 * cannot be read is reported and left out of the decision instead of being
 * treated as empty, so a private profile or Steam outage does not ping
 * everyone or suppress a game.
 */
async function resolveMentions(
  env: Env,
  games: readonly SteamGame[],
  seen: SeenGames,
  fetchImpl: typeof fetch,
): Promise<MentionResolution> {
  const resolution: MentionResolution = {
    games: [],
    mentionsByAppId: new Map(),
    mentionFailures: [],
  };

  if (games.length === 0) {
    return resolution;
  }

  const targets = parseMentionTargets(env.MENTION_USERS);
  const ownedByTarget = new Map<MentionTarget, Set<string>>();

  if (targets.length > 0) {
    const apiKey = env.STEAM_API_KEY;
    if (!apiKey) {
      console.warn(
        "MENTION_USERS is configured but STEAM_API_KEY is missing; DLCs will be skipped and games posted without mentions",
      );
      resolution.mentionFailures.push(...targets.map(mentionLabel));
    } else {
      await mapWithConcurrency(targets, LIBRARY_CONCURRENCY, async (target) => {
        try {
          const owned = await fetchOwnedAppIds(target.steamId, apiKey, fetchImpl);
          ownedByTarget.set(target, owned);
        } catch (cause) {
          resolution.mentionFailures.push(mentionLabel(target));
          console.warn(
            `Could not read Steam library for ${mentionLabel(target)}: ${errorMessage(cause)}`,
          );
        }
      });
    }
  }

  for (const game of games) {
    const entry = seen[game.appId];
    const kind = entry?.kind ?? "game";

    if (kind === "dlc") {
      const baseAppId = entry?.baseAppId;
      if (!baseAppId) {
        console.warn(
          `Skipping Steam DLC ${game.appId}: Steam did not report a base game`,
        );
        continue;
      }

      // Only mention users whose readable library contains the base game. No
      // confirmed owner means nobody can use the DLC, so no message is posted.
      const mentions = targets
        .filter((target) => ownedByTarget.get(target)?.has(baseAppId))
        .map(formatMention);

      if (mentions.length === 0) {
        continue;
      }

      resolution.games.push(game);
      resolution.mentionsByAppId.set(game.appId, mentions);
      continue;
    }

    resolution.games.push(game);

    const mentions: string[] = [];
    for (const target of targets) {
      const owned = ownedByTarget.get(target);
      if (owned !== undefined && !owned.has(game.appId)) {
        mentions.push(formatMention(target));
      }
    }

    if (mentions.length > 0) {
      resolution.mentionsByAppId.set(game.appId, mentions);
    }
  }

  return resolution;
}

/**
 * One scheduled check:
 *   1. Fetch current temporary free games from Steam.
 *   2. Validate candidates we have not priced yet.
 *   3. Notify validated games that were never announced, or whose 30-day
 *      cooldown has expired. DLC is only announced when a configured user owns
 *      its base game.
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

  const candidates = games.filter((game) => isNotificationDue(seen[game.appId], now));

  const { games: notifiableGames, mentionsByAppId, mentionFailures } =
    await resolveMentions(env, candidates, seen, fetchImpl);

  let notified: string[] = [];
  let notificationFailures: string[] = [];

  if (notifiableGames.length > 0) {
    const result = await sendDiscordNotifications(
      env,
      notifiableGames,
      fetchImpl,
      mentionsByAppId,
    );
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
    mentionFailures,
  };

  console.log(
    "Steam free games check complete",
    JSON.stringify({
      gamesFound: result.gamesFound,
      candidates: result.candidates,
      notified: result.notified.length,
      notificationFailures: result.notificationFailures.length,
      validationFailures: result.validationFailures.length,
      mentionFailures: result.mentionFailures.length,
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
