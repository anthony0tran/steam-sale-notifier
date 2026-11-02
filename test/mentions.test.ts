import { describe, expect, it, vi } from "vitest";

import { formatMention, mentionLabel, parseMentionTargets } from "../src/mentions";

describe("parseMentionTargets", () => {
  it("parses a valid user array", () => {
    const raw = JSON.stringify([
      {
        discordId: "123456789012345678",
        discordUsername: "alice",
        steamId: "76561198000000000",
      },
      {
        discordUsername: "@bob",
        steamId: "https://steamcommunity.com/id/bob_steam/",
      },
    ]);

    expect(parseMentionTargets(raw)).toEqual([
      {
        discordId: "123456789012345678",
        discordUsername: "alice",
        steamId: "76561198000000000",
      },
      {
        discordUsername: "bob",
        steamId: "https://steamcommunity.com/id/bob_steam/",
      },
    ]);
  });

  it("accepts alias keys and drops duplicates", () => {
    const raw = JSON.stringify([
      { discord: "123456789012345678", steam: "76561198000000000" },
      { discord: "123456789012345678", steam: "76561198000000000" },
    ]);

    expect(parseMentionTargets(raw)).toEqual([
      { discordId: "123456789012345678", steamId: "76561198000000000" },
    ]);
  });

  it("returns an empty list for missing or invalid JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(parseMentionTargets(undefined)).toEqual([]);
    expect(parseMentionTargets("")).toEqual([]);
    expect(parseMentionTargets("not json")).toEqual([]);
    expect(parseMentionTargets("{}")).toEqual([]);

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("skips entries without a usable Discord identity or Steam id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const raw = JSON.stringify([
      { discordId: "123456789012345678" },
      { discordUsername: "alice" },
      { discordId: "not-an-id", steamId: "76561198000000000" },
      { discordUsername: "bob", steamId: "  " },
    ]);

    expect(parseMentionTargets(raw)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a username-only target as a readable fallback", () => {
    const raw = JSON.stringify([{ discordUsername: "alice", steamId: "alice" }]);

    expect(parseMentionTargets(raw)).toEqual([
      { discordUsername: "alice", steamId: "alice" },
    ]);
  });
});

describe("formatMention", () => {
  it("uses Discord user markup when an id is present", () => {
    expect(
      formatMention({
        discordId: "123456789012345678",
        discordUsername: "alice",
        steamId: "76561198000000000",
      }),
    ).toBe("<@123456789012345678>");
  });

  it("falls back to plain text without an id", () => {
    expect(
      formatMention({ discordUsername: "alice", steamId: "76561198000000000" }),
    ).toBe("@alice");
  });
});

describe("mentionLabel", () => {
  it("prefers the username for logs", () => {
    expect(
      mentionLabel({
        discordId: "123456789012345678",
        discordUsername: "alice",
        steamId: "76561198000000000",
      }),
    ).toBe("alice");
  });
});
