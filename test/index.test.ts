import { describe, expect, it, vi } from "vitest";

import worker, { TEST_SEARCH_URL, runCheck } from "../src/index";
import { SEEN_GAMES_KEY, parseSeenGames } from "../src/state";
import { SteamError } from "../src/steam";
import type { DiscordWebhookPayload, Env } from "../src/types";
import { MemoryKV, asKV, htmlResponse, jsonResponse, mockFetch, searchRows } from "./helpers";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK = "https://discord.com/api/webhooks/123/token";
const STEAM_ID_A = "76561198000000001";
const STEAM_ID_B = "76561198000000002";
const DISCORD_ID_A = "111111111111111111";
const DISCORD_ID_B = "222222222222222222";

interface HarnessOptions {
  games: ReadonlyArray<{ appId: string; name: string }>;
  promotions?: Record<string, boolean>;
  searchStatus?: number;
  validationStatus?: number;
  discordStatus?: number;
  kvRaw?: string;
  triggerToken?: string;
  mentionUsers?: unknown;
  steamApiKey?: string;
  /** SteamID64 -> app ids owned by that account. Missing ids look private. */
  libraries?: Record<string, string[]>;
  libraryStatus?: number;
  /** Per-app appdetails overrides, used for DLC/base-game tests. */
  appDetails?: Record<
    string,
    { type?: string; free?: boolean; baseAppId?: string }
  >;
}

function createHarness(options: HarnessOptions) {
  const kv = new MemoryKV(options.kvRaw === undefined ? {} : { [SEEN_GAMES_KEY]: options.kvRaw });
  const env: Env = {
    SEEN_GAMES: asKV(kv),
    DISCORD_WEBHOOK_URL: WEBHOOK,
    MANUAL_TRIGGER_TOKEN: options.triggerToken,
    MENTION_USERS:
      options.mentionUsers === undefined ? undefined : JSON.stringify(options.mentionUsers),
    STEAM_API_KEY: options.steamApiKey,
  };
  const promotions = options.promotions ?? {};
  const libraries = options.libraries ?? {};
  const discordPayloads: DiscordWebhookPayload[] = [];
  const validated: string[] = [];
  const libraryRequests: string[] = [];
  const searchRequests: string[] = [];

  let searchStatus = options.searchStatus ?? 200;
  let validationStatus = options.validationStatus ?? 200;
  let discordStatus = options.discordStatus ?? 200;
  let libraryStatus = options.libraryStatus ?? 200;

  const fetchImpl = mockFetch((rawUrl, init) => {
    const url = new URL(rawUrl);

    if (url.hostname === "store.steampowered.com" && url.pathname === "/search/") {
      searchRequests.push(rawUrl);
      if (searchStatus !== 200) {
        return new Response("search failed", { status: searchStatus });
      }
      return htmlResponse(searchRows(options.games));
    }

    if (url.pathname === "/api/appdetails") {
      const appId = url.searchParams.get("appids") ?? "";
      validated.push(appId);
      if (validationStatus !== 200) {
        return new Response("details failed", { status: validationStatus });
      }

      const fixture = options.appDetails?.[appId];
      const free = fixture?.free ?? promotions[appId] === true;
      const type = fixture?.type ?? "game";
      const data: Record<string, unknown> = {
        type,
        price_overview: free
          ? { discount_percent: 100, initial: 999, final: 999 }
          : { discount_percent: 50, initial: 1999, final: 999 },
      };
      if (fixture?.baseAppId) {
        data.fullgame = { appid: fixture.baseAppId, name: "Base Game" };
      }

      return jsonResponse({
        [appId]: { success: true, data },
      });
    }

    if (url.hostname === "api.steampowered.com" && url.pathname === "/IPlayerService/GetOwnedGames/v1/") {
      const steamId = url.searchParams.get("steamid") ?? "";
      libraryRequests.push(steamId);
      if (libraryStatus !== 200) {
        return new Response("library failed", { status: libraryStatus });
      }

      const owned = libraries[steamId];
      if (!owned) {
        return jsonResponse({ response: {} });
      }
      return jsonResponse({
        response: {
          game_count: owned.length,
          games: owned.map((appid) => ({ appid: Number(appid) })),
        },
      });
    }

    if (url.hostname === "discord.com") {
      discordPayloads.push(JSON.parse(String(init?.body)) as DiscordWebhookPayload);
      if (discordStatus !== 200) {
        return new Response("bad request", { status: discordStatus });
      }
      return jsonResponse({ id: String(discordPayloads.length) });
    }

    return new Response("not found", { status: 404 });
  });

  return {
    kv,
    env,
    fetchImpl,
    discordPayloads,
    validated,
    libraryRequests,
    searchRequests,
    run: () => runCheck(env, { fetch: fetchImpl, now: () => NOW }),
    setSearchStatus: (status: number) => {
      searchStatus = status;
    },
    setValidationStatus: (status: number) => {
      validationStatus = status;
    },
    setDiscordStatus: (status: number) => {
      discordStatus = status;
    },
    setLibraryStatus: (status: number) => {
      libraryStatus = status;
    },
  };
}

function readState(kv: MemoryKV) {
  return parseSeenGames(kv.store.get(SEEN_GAMES_KEY) ?? null, NOW);
}

describe("runCheck", () => {
  it("notifies and records all promotions when state is empty", async () => {
    const harness = createHarness({
      games: [
        { appId: "10", name: "Alpha" },
        { appId: "20", name: "Beta" },
      ],
      promotions: { "10": true, "20": true },
    });

    const result = await harness.run();

    expect([...result.notified].sort()).toEqual(["10", "20"]);
    expect(result.notificationFailures).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(1);
    expect(harness.discordPayloads[0]?.embeds).toHaveLength(2);

    const state = readState(harness.kv);
    expect(state["10"]?.free).toBe(true);
    expect(state["10"]?.notifiedAt).toBe(NOW);
    expect(state["20"]?.notifiedAt).toBe(NOW);
  });

  it("does not notify again for games already announced", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
    });

    await harness.run();
    harness.discordPayloads.length = 0;
    const validatedBefore = harness.validated.length;

    const result = await harness.run();

    expect(result.notified).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(0);
    expect(harness.validated).toHaveLength(validatedBefore);
  });

  it("re-notifies a game after the one-month cooldown", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      kvRaw: JSON.stringify({
        "10": {
          firstSeenAt: NOW - 60 * DAY,
          lastSeenAt: NOW - DAY,
          free: true,
          kind: "game",
          notifiedAt: NOW - 31 * DAY,
        },
      }),
    });

    const result = await harness.run();

    expect(result.notified).toEqual(["10"]);
    expect(harness.discordPayloads).toHaveLength(1);
    expect(readState(harness.kv)["10"]?.notifiedAt).toBe(NOW);
    // The stored validation is reused; no extra appdetails request.
    expect(harness.validated).toEqual([]);
  });

  it("respects the cooldown for games announced less than a month ago", async () => {
    const notifiedAt = NOW - 29 * DAY;
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      kvRaw: JSON.stringify({
        "10": {
          firstSeenAt: NOW - 60 * DAY,
          lastSeenAt: NOW - DAY,
          free: true,
          kind: "game",
          notifiedAt,
        },
      }),
    });

    const result = await harness.run();

    expect(result.notified).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(0);
    expect(readState(harness.kv)["10"]?.notifiedAt).toBe(notifiedAt);
  });

  it("retries a failed Discord notification on the next run", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      discordStatus: 400,
    });

    const failed = await harness.run();

    expect(failed.notified).toEqual([]);
    expect(failed.notificationFailures).toEqual(["10"]);
    expect(readState(harness.kv)["10"]?.notifiedAt).toBeUndefined();

    harness.setDiscordStatus(200);
    const retried = await harness.run();

    expect(retried.notified).toEqual(["10"]);
    expect(readState(harness.kv)["10"]?.notifiedAt).toBe(NOW);
  });

  it("does not notify for apps that are not 100% off", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Free to play" }],
      promotions: { "10": false },
    });

    const result = await harness.run();

    expect(result.notified).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(0);
    expect(harness.validated).toEqual(["10"]);

    const state = readState(harness.kv);
    expect(state["10"]?.free).toBe(false);
    expect(state["10"]?.notifiedAt).toBeUndefined();
  });

  it("mentions configured users who do not own the free game", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      mentionUsers: [
        { discordId: DISCORD_ID_A, discordUsername: "alice", steamId: STEAM_ID_A },
        { discordId: DISCORD_ID_B, discordUsername: "bob", steamId: STEAM_ID_B },
      ],
      steamApiKey: "test-key",
      libraries: { [STEAM_ID_A]: ["10"], [STEAM_ID_B]: [] },
    });

    const result = await harness.run();

    expect(result.notified).toEqual(["10"]);
    expect(result.mentionFailures).toEqual([]);
    expect([...harness.libraryRequests].sort()).toEqual([STEAM_ID_A, STEAM_ID_B].sort());
    expect(harness.discordPayloads[0]).toMatchObject({
      content: `<@${DISCORD_ID_B}>`,
      allowed_mentions: { parse: [], users: [DISCORD_ID_B] },
    });
    expect(harness.discordPayloads[0]?.embeds).toHaveLength(1);
  });

  it("does not mention anyone when every configured user owns the game", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      mentionUsers: [
        { discordId: DISCORD_ID_A, steamId: STEAM_ID_A },
        { discordId: DISCORD_ID_B, steamId: STEAM_ID_B },
      ],
      steamApiKey: "test-key",
      libraries: { [STEAM_ID_A]: ["10"], [STEAM_ID_B]: ["10", "20"] },
    });

    await harness.run();

    expect(harness.discordPayloads).toHaveLength(1);
    expect(harness.discordPayloads[0]?.content).toBeUndefined();
    expect(harness.discordPayloads[0]?.allowed_mentions).toBeUndefined();
  });

  it("still posts when a Steam library cannot be read", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      mentionUsers: [
        { discordId: DISCORD_ID_A, discordUsername: "alice", steamId: STEAM_ID_A },
        { discordId: DISCORD_ID_B, discordUsername: "bob", steamId: STEAM_ID_B },
      ],
      steamApiKey: "test-key",
      libraryStatus: 500,
    });

    const result = await harness.run();

    expect(result.notified).toEqual(["10"]);
    expect([...result.mentionFailures].sort()).toEqual(["alice", "bob"]);
    expect(harness.discordPayloads[0]?.content).toBeUndefined();
    expect(readState(harness.kv)["10"]?.notifiedAt).toBe(NOW);
  });

  it("skips mentions but still posts when STEAM_API_KEY is missing", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      mentionUsers: [
        { discordId: DISCORD_ID_A, discordUsername: "alice", steamId: STEAM_ID_A },
      ],
    });

    const result = await harness.run();

    expect(result.notified).toEqual(["10"]);
    expect(result.mentionFailures).toEqual(["alice"]);
    expect(harness.libraryRequests).toEqual([]);
    expect(harness.discordPayloads[0]?.content).toBeUndefined();
  });

  it("does not read libraries when no game is due", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      mentionUsers: [
        { discordId: DISCORD_ID_A, discordUsername: "alice", steamId: STEAM_ID_A },
      ],
      steamApiKey: "test-key",
      libraries: { [STEAM_ID_A]: [] },
      kvRaw: JSON.stringify({
        "10": {
          firstSeenAt: NOW - DAY,
          lastSeenAt: NOW - DAY,
          free: true,
          kind: "game",
          notifiedAt: NOW - DAY,
        },
      }),
    });

    const result = await harness.run();

    expect(result.notified).toEqual([]);
    expect(harness.libraryRequests).toEqual([]);
  });

  it("posts a 100%-off DLC and mentions users who own the base game", async () => {
    const harness = createHarness({
      games: [{ appId: "30", name: "Expansion DLC" }],
      appDetails: { "30": { type: "dlc", free: true, baseAppId: "10" } },
      mentionUsers: [
        { discordId: DISCORD_ID_A, discordUsername: "alice", steamId: STEAM_ID_A },
        { discordId: DISCORD_ID_B, discordUsername: "bob", steamId: STEAM_ID_B },
      ],
      steamApiKey: "test-key",
      libraries: {
        [STEAM_ID_A]: ["10", "99"],
        [STEAM_ID_B]: ["99"],
      },
    });

    const result = await harness.run();

    expect(result.notified).toEqual(["30"]);
    expect(result.mentionFailures).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(1);
    expect(harness.discordPayloads[0]).toMatchObject({
      content: `<@${DISCORD_ID_A}>`,
      allowed_mentions: { parse: [], users: [DISCORD_ID_A] },
    });
    expect(harness.discordPayloads[0]?.embeds).toHaveLength(1);

    const state = readState(harness.kv)["30"];
    expect(state?.free).toBe(true);
    expect(state?.kind).toBe("dlc");
    expect(state?.baseAppId).toBe("10");
    expect(state?.notifiedAt).toBe(NOW);
  });

  it("does not post a 100%-off DLC when nobody owns the base game", async () => {
    const harness = createHarness({
      games: [{ appId: "30", name: "Expansion DLC" }],
      appDetails: { "30": { type: "dlc", free: true, baseAppId: "10" } },
      mentionUsers: [
        { discordId: DISCORD_ID_A, discordUsername: "alice", steamId: STEAM_ID_A },
        { discordId: DISCORD_ID_B, discordUsername: "bob", steamId: STEAM_ID_B },
      ],
      steamApiKey: "test-key",
      libraries: {
        [STEAM_ID_A]: ["99"],
        [STEAM_ID_B]: [],
      },
    });

    const result = await harness.run();

    expect(result.notified).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(0);

    const state = readState(harness.kv)["30"];
    expect(state?.free).toBe(true);
    expect(state?.kind).toBe("dlc");
    expect(state?.baseAppId).toBe("10");
    expect(state?.notifiedAt).toBeUndefined();
  });

  it("does not post a 100%-off DLC without configured libraries", async () => {
    const harness = createHarness({
      games: [{ appId: "30", name: "Expansion DLC" }],
      appDetails: { "30": { type: "dlc", free: true, baseAppId: "10" } },
    });

    const result = await harness.run();

    expect(result.notified).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(0);
  });

  it("does not write state when the Steam search fails", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      searchStatus: 500,
    });

    await expect(harness.run()).rejects.toBeInstanceOf(SteamError);
    expect(harness.kv.store.size).toBe(0);
  });

  it("retries validation when Steam appdetails failed", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      validationStatus: 500,
    });

    const first = await harness.run();

    expect(first.notified).toEqual([]);
    expect(first.validationFailures).toEqual(["10"]);
    expect(readState(harness.kv)["10"]?.free).toBeUndefined();

    harness.setValidationStatus(200);
    const second = await harness.run();

    expect(second.notified).toEqual(["10"]);
    expect(readState(harness.kv)["10"]?.free).toBe(true);
  });

  it("prunes apps that have not appeared in the results for 90 days", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      kvRaw: JSON.stringify({
        "999": { firstSeenAt: NOW - 100 * DAY, lastSeenAt: NOW - 100 * DAY },
      }),
    });

    await harness.run();

    const state = readState(harness.kv);
    expect(state["10"]).toBeDefined();
    expect(state["999"]).toBeUndefined();
    expect(harness.validated).toEqual(["10"]);
  });

  it("migrates the legacy seen-id array without re-notifying", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      kvRaw: '["10"]',
    });

    const result = await harness.run();

    expect(result.notified).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(0);
    expect(readState(harness.kv)["10"]?.notifiedAt).toBe(NOW);
  });
});

describe("scheduled handler", () => {
  it("runs the check and persists the notification state", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
    });

    vi.stubGlobal("fetch", harness.fetchImpl);
    try {
      await worker.scheduled(
        {} as unknown as ScheduledController,
        harness.env,
        {} as unknown as ExecutionContext,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(harness.discordPayloads).toHaveLength(1);
    expect(readState(harness.kv)["10"]?.notifiedAt).toBeTypeOf("number");
  });
});

describe("manual check endpoint", () => {
  const callWorker = async (
    harness: ReturnType<typeof createHarness>,
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    vi.stubGlobal("fetch", harness.fetchImpl);
    try {
      return await worker.fetch(
        new Request(`https://worker.example${path}`, init),
        harness.env,
        {} as unknown as ExecutionContext,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("serves a health response at the root", async () => {
    const harness = createHarness({ games: [], triggerToken: "secret" });

    const response = await callWorker(harness, "/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "steam-sale-notifier",
    });
    expect(harness.validated).toEqual([]);
  });

  it("rejects requests without a valid bearer token", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      triggerToken: "secret",
    });

    const missing = await callWorker(harness, "/check");
    const wrong = await callWorker(harness, "/check", {
      headers: { authorization: "Bearer wrong" },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect(harness.validated).toEqual([]);
    expect(harness.discordPayloads).toHaveLength(0);
    expect(harness.kv.store.size).toBe(0);
  });

  it("returns 503 when no manual token is configured", async () => {
    const harness = createHarness({ games: [], triggerToken: undefined });

    const response = await callWorker(harness, "/check", {
      headers: { authorization: "Bearer anything" },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "MANUAL_TRIGGER_TOKEN is not configured",
    });
    expect(harness.validated).toEqual([]);
  });

  it("runs the check with a valid token and returns the summary", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      triggerToken: "secret",
    });

    const response = await callWorker(harness, "/check", {
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      gamesFound: number;
      notified: string[];
      notificationFailures: string[];
    };
    expect(body).toMatchObject({
      ok: true,
      gamesFound: 1,
      notified: ["10"],
      notificationFailures: [],
    });
    expect(harness.discordPayloads).toHaveLength(1);
    expect(readState(harness.kv)["10"]?.notifiedAt).toBeTypeOf("number");
  });

  it("accepts POST as well as GET", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      promotions: { "10": true },
      triggerToken: "secret",
    });

    const response = await callWorker(harness, "/check", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    expect(harness.discordPayloads).toHaveLength(1);
  });

  it("returns 500 with an error message when the check fails", async () => {
    const harness = createHarness({
      games: [{ appId: "10", name: "Alpha" }],
      searchStatus: 500,
      triggerToken: "secret",
    });

    const response = await callWorker(harness, "/check", {
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Steam search returned HTTP 500",
    });
    expect(harness.kv.store.size).toBe(0);
  });

  it("returns 404 for unknown paths and 405 for other methods", async () => {
    const harness = createHarness({ games: [], triggerToken: "secret" });

    const notFound = await callWorker(harness, "/nope");
    const notAllowed = await callWorker(harness, "/check", {
      method: "DELETE",
      headers: { authorization: "Bearer secret" },
    });

    expect(notFound.status).toBe(404);
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get("allow")).toBe("GET, POST");
  });
});

describe("test notification endpoint", () => {
  const callWorker = async (
    harness: ReturnType<typeof createHarness>,
    path: string,
    init?: RequestInit,
  ): Promise<Response> => {
    vi.stubGlobal("fetch", harness.fetchImpl);
    try {
      return await worker.fetch(
        new Request(`https://worker.example${path}`, init),
        harness.env,
        {} as unknown as ExecutionContext,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("posts the first three games from the test search", async () => {
    const harness = createHarness({
      games: [
        { appId: "1", name: "One" },
        { appId: "2", name: "Two" },
        { appId: "3", name: "Three" },
        { appId: "4", name: "Four" },
      ],
      triggerToken: "secret",
    });

    const response = await callWorker(harness, "/test", {
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      gamesFound: number;
      games: Array<{ appId: string }>;
      notified: string[];
    };
    expect(body).toMatchObject({
      ok: true,
      gamesFound: 4,
      notified: ["1", "2", "3"],
    });
    expect(body.games.map((game) => game.appId)).toEqual(["1", "2", "3"]);

    expect(harness.discordPayloads).toHaveLength(1);
    expect(harness.discordPayloads[0]?.embeds).toHaveLength(3);
    expect(harness.searchRequests).toEqual([TEST_SEARCH_URL]);

    // The test endpoint must not validate or write KV state.
    expect(harness.validated).toEqual([]);
    expect(harness.kv.store.size).toBe(0);
  });

  it("posts even when KV says the games were already notified", async () => {
    const harness = createHarness({
      games: [
        { appId: "1", name: "One" },
        { appId: "2", name: "Two" },
        { appId: "3", name: "Three" },
      ],
      triggerToken: "secret",
      kvRaw: JSON.stringify({
        "1": {
          firstSeenAt: NOW - DAY,
          lastSeenAt: NOW - DAY,
          free: true,
          kind: "game",
          notifiedAt: NOW - DAY,
        },
      }),
    });
    const stateBefore = harness.kv.store.get(SEEN_GAMES_KEY);

    const response = await callWorker(harness, "/test", {
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notified: ["1", "2", "3"],
    });
    expect(harness.discordPayloads[0]?.embeds).toHaveLength(3);
    expect(harness.kv.store.get(SEEN_GAMES_KEY)).toBe(stateBefore);
  });

  it("applies the configured mentions", async () => {
    const harness = createHarness({
      games: [
        { appId: "10", name: "Alpha" },
        { appId: "20", name: "Beta" },
        { appId: "30", name: "Gamma" },
      ],
      triggerToken: "secret",
      mentionUsers: [
        { discordId: DISCORD_ID_A, steamId: STEAM_ID_A },
        { discordId: DISCORD_ID_B, steamId: STEAM_ID_B },
      ],
      steamApiKey: "test-key",
      libraries: {
        [STEAM_ID_A]: ["10"],
        [STEAM_ID_B]: [],
      },
    });

    await callWorker(harness, "/test", {
      headers: { authorization: "Bearer secret" },
    });

    expect(harness.discordPayloads[0]).toMatchObject({
      content: `<@${DISCORD_ID_B}> <@${DISCORD_ID_A}>`,
      allowed_mentions: {
        parse: [],
        users: [DISCORD_ID_B, DISCORD_ID_A],
      },
    });
  });

  it("requires the manual trigger token", async () => {
    const harness = createHarness({
      games: [{ appId: "1", name: "One" }],
      triggerToken: "secret",
    });

    const response = await callWorker(harness, "/test");

    expect(response.status).toBe(401);
    expect(harness.discordPayloads).toHaveLength(0);
  });
});
