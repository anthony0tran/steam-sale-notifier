import { describe, expect, it } from "vitest";

import {
  SEEN_GAMES_KEY,
  SEEN_GAMES_MAX_AGE_MS,
  getSeenGames,
  parseSeenGames,
  pruneSeenGames,
  saveSeenGames,
} from "../src/state";
import type { Env, SeenGames } from "../src/types";
import { MemoryKV, asKV } from "./helpers";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

function envWith(kv: MemoryKV): Env {
  return { SEEN_GAMES: asKV(kv), DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x/y" };
}

describe("parseSeenGames", () => {
  it("migrates the legacy array format without re-notifying", () => {
    const seen = parseSeenGames('["570","730"]', NOW);

    expect(Object.keys(seen)).toEqual(["570", "730"]);
    expect(seen["570"]).toEqual({
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      free: true,
      notifiedAt: NOW,
    });
  });

  it("returns an empty object for missing or corrupt state", () => {
    expect(parseSeenGames(null)).toEqual({});
    expect(parseSeenGames("not json")).toEqual({});
    expect(parseSeenGames("42")).toEqual({});
  });

  it("keeps known fields and ignores invalid entries", () => {
    const raw = JSON.stringify({
      "10": { firstSeenAt: 1, lastSeenAt: 2, free: true, notifiedAt: 3 },
      "20": { lastSeenAt: 5 },
      bad: { lastSeenAt: 5 },
      "30": "nope",
    });

    const seen = parseSeenGames(raw, NOW);

    expect(seen).toEqual({
      "10": { firstSeenAt: 1, lastSeenAt: 2, free: true, notifiedAt: 3 },
      "20": { firstSeenAt: NOW, lastSeenAt: 5 },
    });
  });
});

describe("KV persistence", () => {
  it("round-trips state through the KV binding", async () => {
    const kv = new MemoryKV();
    const env = envWith(kv);
    const state: SeenGames = {
      "10": { firstSeenAt: NOW, lastSeenAt: NOW, free: true },
    };

    await saveSeenGames(env, state);
    await expect(getSeenGames(env)).resolves.toEqual(state);
    expect(kv.store.has(SEEN_GAMES_KEY)).toBe(true);
  });

  it("reads an empty store as empty state", async () => {
    await expect(getSeenGames(envWith(new MemoryKV()))).resolves.toEqual({});
  });
});

describe("pruneSeenGames", () => {
  it("drops entries not seen within the retention window", () => {
    const seen: SeenGames = {
      fresh: { firstSeenAt: NOW - 1000, lastSeenAt: NOW - 1000 },
      edge: { firstSeenAt: 0, lastSeenAt: NOW - SEEN_GAMES_MAX_AGE_MS },
      stale: { firstSeenAt: 0, lastSeenAt: NOW - SEEN_GAMES_MAX_AGE_MS - 1 },
    };

    expect(Object.keys(pruneSeenGames(seen, NOW))).toEqual(["fresh", "edge"]);
  });
});
