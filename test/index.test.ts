import { describe, expect, it, vi } from "vitest";

import worker, { runCheck } from "../src/index";
import { SEEN_GAMES_KEY, parseSeenGames } from "../src/state";
import { SteamError } from "../src/steam";
import type { DiscordWebhookPayload, Env } from "../src/types";
import { MemoryKV, asKV, htmlResponse, jsonResponse, mockFetch, searchRows } from "./helpers";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK = "https://discord.com/api/webhooks/123/token";

interface HarnessOptions {
  games: ReadonlyArray<{ appId: string; name: string }>;
  promotions?: Record<string, boolean>;
  searchStatus?: number;
  validationStatus?: number;
  discordStatus?: number;
  kvRaw?: string;
}

function createHarness(options: HarnessOptions) {
  const kv = new MemoryKV(options.kvRaw === undefined ? {} : { [SEEN_GAMES_KEY]: options.kvRaw });
  const env: Env = { SEEN_GAMES: asKV(kv), DISCORD_WEBHOOK_URL: WEBHOOK };
  const promotions = options.promotions ?? {};
  const discordPayloads: DiscordWebhookPayload[] = [];
  const validated: string[] = [];

  let searchStatus = options.searchStatus ?? 200;
  let validationStatus = options.validationStatus ?? 200;
  let discordStatus = options.discordStatus ?? 200;

  const fetchImpl = mockFetch((rawUrl, init) => {
    const url = new URL(rawUrl);

    if (url.hostname === "store.steampowered.com" && url.pathname === "/search/") {
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

      const free = promotions[appId] === true;
      return jsonResponse({
        [appId]: {
          success: true,
          data: free
            ? { type: "game", price_overview: { discount_percent: 100, initial: 999, final: 999 } }
            : { type: "game", price_overview: { discount_percent: 50, initial: 1999, final: 999 } },
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
