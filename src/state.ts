import type { Env, SeenGame, SeenGames } from "./types";

export const SEEN_GAMES_KEY = "steam:seen-games";
export const SEEN_GAMES_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAppId(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Read the KV value, tolerating the PRD's original `["570", "730"]` shape so an
 * existing deployment can migrate without losing its notification history.
 */
export function parseSeenGames(raw: string | null, now: number = Date.now()): SeenGames {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("Ignoring unreadable seen-games state in KV");
    return {};
  }

  const result: SeenGames = {};

  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      if (typeof value === "string" && isAppId(value)) {
        // These ids were already announced under the old format, so mark them
        // as both free and notified to avoid a burst of duplicate messages.
        result[value] = { firstSeenAt: now, lastSeenAt: now, free: true, notifiedAt: now };
      }
    }
    return result;
  }

  if (!isRecord(parsed)) {
    return {};
  }

  for (const [appId, value] of Object.entries(parsed)) {
    if (!isAppId(appId) || !isRecord(value)) {
      continue;
    }

    const firstSeenAt = typeof value.firstSeenAt === "number" ? value.firstSeenAt : now;
    const lastSeenAt = typeof value.lastSeenAt === "number" ? value.lastSeenAt : firstSeenAt;
    const entry: SeenGame = { firstSeenAt, lastSeenAt };

    if (typeof value.free === "boolean") {
      entry.free = value.free;
    }
    if (typeof value.notifiedAt === "number") {
      entry.notifiedAt = value.notifiedAt;
    }

    result[appId] = entry;
  }

  return result;
}

export async function getSeenGames(env: Env, now: number = Date.now()): Promise<SeenGames> {
  const raw = await env.SEEN_GAMES.get(SEEN_GAMES_KEY);
  return parseSeenGames(raw, now);
}

export async function saveSeenGames(env: Env, seen: SeenGames): Promise<void> {
  await env.SEEN_GAMES.put(SEEN_GAMES_KEY, JSON.stringify(seen));
}

/**
 * Drop apps that have not appeared in the search results for a while. A game
 * that goes free again after the promotion ended is then announced again.
 */
export function pruneSeenGames(
  seen: SeenGames,
  now: number,
  maxAgeMs: number = SEEN_GAMES_MAX_AGE_MS,
): SeenGames {
  const cutoff = now - maxAgeMs;
  const result: SeenGames = {};

  for (const [appId, entry] of Object.entries(seen)) {
    if (entry.lastSeenAt >= cutoff) {
      result[appId] = entry;
    }
  }

  return result;
}
