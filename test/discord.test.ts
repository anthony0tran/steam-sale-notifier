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
      color: 3_066_993,
    });
  });

  it("renders image, platforms, release date, price and reviews", () => {
    const imageUrl =
      "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1583850/capsule.jpg?t=1793381725";
    const game: SteamGame = {
      appId: "1583850",
      name: "Asleep: Act 1",
      url: "https://store.steampowered.com/app/1583850/",
      imageUrl,
      platforms: ["Windows", "macOS", "Linux"],
      releaseDate: "10 May, 2024",
      price: { original: "9,75€", final: "0,00€", discountPercent: 100 },
      review: {
        summary: "Very Positive",
        percent: 91,
        count: 316,
        tone: "positive",
      },
    };

    expect(formatEmbed(game)).toEqual({
      title: "Asleep: Act 1",
      url: "https://store.steampowered.com/app/1583850/",
      color: 3_066_993,
      fields: [
        { name: "Platforms", value: "Windows · macOS · Linux", inline: true },
        { name: "Release date", value: "10 May, 2024", inline: true },
        { name: "Price", value: "~~9,75€~~ **0,00€** -100%", inline: true },
        {
          name: "Reviews",
          value: "👍 Very Positive · 91% · 316 reviews",
          inline: false,
        },
      ],
      image: { url: imageUrl },
    });
  });

  it("renders the review tone when no summary is available", () => {
    const [base] = games(1);

    expect(
      formatEmbed({ ...(base as SteamGame), review: { tone: "mixed" } }),
    ).toMatchObject({
      fields: [{ name: "Reviews", value: "🤔", inline: false }],
    });
  });

  it("does not repeat the original price when both prices are equal", () => {
    const [base] = games(1);

    expect(
      formatEmbed({
        ...(base as SteamGame),
        price: { original: "0,00€", final: "0,00€", discountPercent: 100 },
      }),
    ).toMatchObject({
      fields: [{ name: "Price", value: "**0,00€** -100%", inline: true }],
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

  it("aggregates and deduplicates mentions per message", () => {
    const mentions = new Map<string, string[]>([
      ["1", ["<@111111111111111111>", "<@222222222222222222>"]],
      ["2", ["<@222222222222222222>"]],
    ]);

    const [payload] = buildDiscordPayloads(games(2), mentions);

    expect(payload?.content).toBe(
      "<@111111111111111111> <@222222222222222222>",
    );
    expect(payload?.allowed_mentions).toEqual({
      parse: [],
      users: ["111111111111111111", "222222222222222222"],
    });
  });

  it("keeps username fallbacks but disables all pings", () => {
    const mentions = new Map([["1", ["@alice"]]]);

    const [payload] = buildDiscordPayloads(games(1), mentions);

    expect(payload?.content).toBe("@alice");
    expect(payload?.allowed_mentions).toEqual({ parse: [] });
  });

  it("does not add mention fields when nobody is mentioned", () => {
    const [payload] = buildDiscordPayloads(games(1));

    expect(payload?.content).toBeUndefined();
    expect(payload?.allowed_mentions).toBeUndefined();
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

  it("posts mentions with the notification", async () => {
    const payloads: Array<{ content?: string }> = [];
    const fetchImpl = mockFetch((_url, init) => {
      payloads.push(JSON.parse(String(init?.body)) as { content?: string });
      return jsonResponse({ id: "1" });
    });

    await sendDiscordNotifications(
      envWith(),
      games(1),
      fetchImpl,
      new Map([["1", ["<@111111111111111111>"]]]),
    );

    expect(payloads[0]?.content).toBe("<@111111111111111111>");
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
