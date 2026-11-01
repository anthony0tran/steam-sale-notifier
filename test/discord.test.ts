import { describe, expect, it } from "vitest";

import {
  DiscordError,
  buildDiscordPayloads,
  formatEmbed,
  sendDiscordNotifications,
} from "../src/discord";
import type { Env, SteamGame } from "../src/types";
import { jsonResponse, mockFetch } from "./helpers";

const WEBHOOK = "https://discord.com/api/webhooks/123/token";

function envWith(webhook = WEBHOOK): Env {
  return { SEEN_GAMES: {} as KVNamespace, DISCORD_WEBHOOK_URL: webhook };
}

function games(count: number): SteamGame[] {
  return Array.from({ length: count }, (_, index) => ({
    appId: String(index + 1),
    name: `Game ${index + 1}`,
    url: `https://store.steampowered.com/app/${index + 1}/`,
  }));
}

describe("formatEmbed", () => {
  it("builds an embed with the store link", () => {
    expect(formatEmbed(games(1)[0] as SteamGame)).toEqual({
      title: "Game 1",
      url: "https://store.steampowered.com/app/1/",
      description: "Now temporarily free on Steam.",
      color: 3_066_993,
    });
  });

  it("truncates titles to Discord's limit", () => {
    const [game] = games(1);
    const embed = formatEmbed({ ...(game as SteamGame), name: "x".repeat(300) });

    expect(embed.title).toHaveLength(256);
    expect(embed.title?.endsWith("…")).toBe(true);
  });
});

describe("buildDiscordPayloads", () => {
  it("splits into batches of ten embeds", () => {
    const payloads = buildDiscordPayloads(games(25));

    expect(payloads.map((payload) => payload.embeds.length)).toEqual([10, 10, 5]);
    expect(payloads.flatMap((payload) => payload.embeds)).toHaveLength(25);
  });

  it("returns no payloads for no games", () => {
    expect(buildDiscordPayloads([])).toEqual([]);
  });
});

describe("sendDiscordNotifications", () => {
  it("posts embeds and reports the apps Discord accepted", async () => {
    const payloads: unknown[] = [];
    const fetchImpl = mockFetch((url, init) => {
      expect(new URL(url).searchParams.get("wait")).toBe("true");
      payloads.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: "1" });
    });

    const result = await sendDiscordNotifications(envWith(), games(2), fetchImpl);

    expect(result).toEqual({ sentAppIds: ["1", "2"], failedAppIds: [] });
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as { embeds: unknown[] }).embeds).toHaveLength(2);
  });

  it("retries after a rate-limit response", async () => {
    let attempts = 0;
    const fetchImpl = mockFetch(() => {
      attempts++;
      if (attempts === 1) {
        return jsonResponse({ retry_after: 0, message: "rate limited" }, 429);
      }
      return jsonResponse({ id: "1" });
    });

    const result = await sendDiscordNotifications(envWith(), games(1), fetchImpl);

    expect(attempts).toBe(2);
    expect(result.sentAppIds).toEqual(["1"]);
  });

  it("reports failed batches without throwing", async () => {
    const fetchImpl = mockFetch(() => new Response("bad request", { status: 400 }));

    const result = await sendDiscordNotifications(envWith(), games(3), fetchImpl);

    expect(result.sentAppIds).toEqual([]);
    expect(result.failedAppIds).toEqual(["1", "2", "3"]);
  });

  it("keeps sending later batches after an earlier one fails", async () => {
    let call = 0;
    const fetchImpl = mockFetch(() => {
      call++;
      if (call === 1) {
        return new Response("bad request", { status: 400 });
      }
      return jsonResponse({ id: "2" });
    });

    const result = await sendDiscordNotifications(envWith(), games(11), fetchImpl);

    expect(result.failedAppIds).toEqual(games(10).map((game) => game.appId));
    expect(result.sentAppIds).toEqual(["11"]);
  });

  it("does nothing when there are no games", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("should not be called");
    });

    await expect(sendDiscordNotifications(envWith(), [], fetchImpl)).resolves.toEqual({
      sentAppIds: [],
      failedAppIds: [],
    });
  });

  it("throws when the webhook secret is missing", async () => {
    await expect(
      sendDiscordNotifications(envWith(""), games(1), mockFetch(() => jsonResponse({}))),
    ).rejects.toBeInstanceOf(DiscordError);
  });
});
