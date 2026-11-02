import { describe, expect, it } from "vitest";

import {
  SteamLibraryError,
  fetchOwnedAppIds,
  resolveSteamId,
} from "../src/steam-library";
import { jsonResponse, mockFetch } from "./helpers";

const API_KEY = "test-key";
const STEAM_ID = "76561198000000000";

describe("resolveSteamId", () => {
  it("accepts a SteamID64 without calling Steam", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("should not be called");
    });

    await expect(resolveSteamId(STEAM_ID, API_KEY, fetchImpl)).resolves.toBe(STEAM_ID);
  });

  it("extracts a SteamID64 from a profile URL without calling Steam", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("should not be called");
    });

    await expect(
      resolveSteamId(`https://steamcommunity.com/profiles/${STEAM_ID}/`, API_KEY, fetchImpl),
    ).resolves.toBe(STEAM_ID);
  });

  it("resolves a vanity name through the Steam Web API", async () => {
    let requested: URL | undefined;
    const fetchImpl = mockFetch((url) => {
      requested = new URL(url);
      return jsonResponse({ response: { success: 1, steamid: STEAM_ID } });
    });

    await expect(
      resolveSteamId("https://steamcommunity.com/id/alice/", API_KEY, fetchImpl),
    ).resolves.toBe(STEAM_ID);

    expect(requested?.pathname).toBe("/ISteamUser/ResolveVanityURL/v1/");
    expect(requested?.searchParams.get("key")).toBe(API_KEY);
    expect(requested?.searchParams.get("vanityurl")).toBe("alice");
  });

  it("throws when Steam cannot resolve a vanity name", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ response: { success: 42, message: "No match" } }),
    );

    await expect(resolveSteamId("nobody", API_KEY, fetchImpl)).rejects.toBeInstanceOf(
      SteamLibraryError,
    );
  });
});

describe("fetchOwnedAppIds", () => {
  it("returns the app ids from a public library", async () => {
    let requested: URL | undefined;
    const fetchImpl = mockFetch((url) => {
      requested = new URL(url);
      return jsonResponse({
        response: {
          game_count: 3,
          games: [{ appid: 10 }, { appid: 20 }, { appid: "ignored" }, { appid: 30 }],
        },
      });
    });

    await expect(fetchOwnedAppIds(STEAM_ID, API_KEY, fetchImpl)).resolves.toEqual(
      new Set(["10", "20", "30"]),
    );

    expect(requested?.pathname).toBe("/IPlayerService/GetOwnedGames/v1/");
    expect(requested?.searchParams.get("steamid")).toBe(STEAM_ID);
    expect(requested?.searchParams.get("include_played_free_games")).toBe("1");
  });

  it("treats an empty response as an unreadable library", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ response: {} }));

    await expect(fetchOwnedAppIds(STEAM_ID, API_KEY, fetchImpl)).rejects.toBeInstanceOf(
      SteamLibraryError,
    );
  });

  it("throws on an HTTP error", async () => {
    const fetchImpl = mockFetch(() => new Response("forbidden", { status: 403 }));

    await expect(fetchOwnedAppIds(STEAM_ID, API_KEY, fetchImpl)).rejects.toMatchObject({
      name: "SteamLibraryError",
      status: 403,
    });
  });

  it("returns an empty set for an empty but readable library", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ response: { game_count: 0 } }),
    );

    await expect(fetchOwnedAppIds(STEAM_ID, API_KEY, fetchImpl)).resolves.toEqual(
      new Set(),
    );
  });
});
