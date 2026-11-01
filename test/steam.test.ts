import { describe, expect, it } from "vitest";

import {
  SteamError,
  fetchSteamFreeGames,
  isTemporarilyFree,
  parseSteamSearchHtml,
} from "../src/steam";
import { htmlResponse, jsonResponse, mockFetch, searchRow, searchRows } from "./helpers";

const BUNDLE_ROW =
  `<a href="https://store.steampowered.com/bundle/123/" class="search_result_row" ` +
  `data-ds-bundleid="123"><div class="col search_name"><span class="title">Some Bundle</span></div></a>`;

const RICH_ROW = `
<a href="https://store.steampowered.com/app/1583850/Asleep_Act_1/?snr=1_7_7_2300_150_1" data-ds-appid="1583850" data-ds-itemkey="App_1583850" class="search_result_row ds_collapse_flag app_impression_tracked">
  <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1583850/f24ce1b7829455b3b0c481374c2f909fdcba766a/capsule_231x87_alt_assets_1.jpg?t=1793381725"></div>
  <div class="responsive_search_name_combined">
    <div class="search_name ellipsis"><span class="title">Asleep: Act 1</span></div>
    <div class="search_platforms"><span class="platform_img win"></span><span class="platform_img mac"></span><span class="platform_img linux"></span></div>
    <div class="search_released responsive_secondrow">10 May, 2024</div>
    <div class="search_reviewscore responsive_secondrow">
      <span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;91% of the 316 user reviews for this game are positive."></span>
    </div>
    <div class="search_price_discount_combined responsive_secondrow" data-price-final="0">
      <div class="discount_block search_discount_block" data-price-final="0" data-bundlediscount="0" data-discount="100">
        <div class="discount_pct" aria-hidden="true">-100%</div>
        <div class="discount_prices" aria-hidden="true">
          <div class="discount_original_price">9,75€</div>
          <div class="discount_final_price">0,00€</div>
        </div>
      </div>
    </div>
  </div>
</a>`;

describe("parseSteamSearchHtml", () => {
  it("extracts app id, title and canonical store url", () => {
    const games = parseSteamSearchHtml(searchRow("570", "Dota 2"));

    expect(games).toEqual([
      {
        appId: "570",
        name: "Dota 2",
        url: "https://store.steampowered.com/app/570/",
      },
    ]);
  });

  it("decodes html entities and collapses whitespace", () => {
    const games = parseSteamSearchHtml(searchRow("730", "Tom &amp; Jerry&#39;s   Quest"));

    expect(games[0]?.name).toBe("Tom & Jerry's Quest");
  });

  it("skips bundles and rows without a title", () => {
    const html =
      `<div id="search_resultsRows">${searchRow("10", "Alpha Game")}${BUNDLE_ROW}` +
      `<a class="search_result_row" data-ds-appid="20"><div class="col search_name"></div></a></div>`;

    expect(parseSteamSearchHtml(html).map((game) => game.appId)).toEqual(["10"]);
  });

  it("deduplicates repeated app ids", () => {
    const html = searchRow("10", "Alpha") + searchRow("10", "Alpha again") + searchRow("20", "Beta");

    expect(parseSteamSearchHtml(html).map((game) => game.appId)).toEqual(["10", "20"]);
  });

  it("extracts image, platforms, release date, price and reviews", () => {
    const [game] = parseSteamSearchHtml(RICH_ROW);

    expect(game).toEqual({
      appId: "1583850",
      name: "Asleep: Act 1",
      url: "https://store.steampowered.com/app/1583850/",
      imageUrl:
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1583850/f24ce1b7829455b3b0c481374c2f909fdcba766a/capsule_231x87_alt_assets_1.jpg?t=1793381725",
      platforms: ["Windows", "macOS", "Linux"],
      releaseDate: "10 May, 2024",
      price: { original: "9,75€", final: "0,00€", discountPercent: 100 },
      review: {
        summary: "Very Positive",
        percent: 91,
        count: 316,
        tone: "positive",
      },
    });
  });

  it("keeps platform order and drops duplicates", () => {
    const html =
      `<a href="https://store.steampowered.com/app/30/" class="search_result_row" data-ds-appid="30">` +
      `<span class="title">Gamma</span>` +
      `<span class="platform_img linux"></span><span class="platform_img win"></span>` +
      `<span class="platform_img win"></span></a>`;

    expect(parseSteamSearchHtml(html)[0]?.platforms).toEqual(["Windows", "Linux"]);
  });

  it("falls back to the review tone when no tooltip is available", () => {
    const html =
      `<a href="https://store.steampowered.com/app/40/" class="search_result_row" data-ds-appid="40">` +
      `<span class="title">Delta</span>` +
      `<span class="search_review_summary mixed"></span></a>`;

    expect(parseSteamSearchHtml(html)[0]?.review).toEqual({ tone: "mixed" });
  });

  it("omits metadata that is not present in the row", () => {
    const [game] = parseSteamSearchHtml(searchRow("10", "Alpha"));

    expect(game).toEqual({
      appId: "10",
      name: "Alpha",
      url: "https://store.steampowered.com/app/10/",
    });
  });
});

describe("fetchSteamFreeGames", () => {
  it("follows pagination until a short page", async () => {
    const calls: string[] = [];
    const firstPage = Array.from({ length: 25 }, (_, index) => ({
      appId: String(index + 1),
      name: `Game ${index + 1}`,
    }));
    const secondPage = [
      { appId: "26", name: "Game 26" },
      { appId: "27", name: "Game 27" },
      { appId: "28", name: "Game 28" },
    ];

    const fetchImpl = mockFetch((url) => {
      calls.push(url);
      const start = new URL(url).searchParams.get("start");
      if (start === null) {
        return htmlResponse(searchRows(firstPage));
      }
      if (start === "25") {
        return htmlResponse(searchRows(secondPage));
      }
      return htmlResponse("<div>No results were returned by the search.</div>");
    });

    const games = await fetchSteamFreeGames(fetchImpl);

    expect(games).toHaveLength(28);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1] ?? "").searchParams.get("cc")).toBe("nl");
  });

  it("deduplicates ids when offsets are ignored", async () => {
    const page = Array.from({ length: 25 }, (_, index) => ({
      appId: String(index + 1),
      name: `Game ${index + 1}`,
    }));

    const games = await fetchSteamFreeGames(mockFetch(() => htmlResponse(searchRows(page))));

    expect(games).toHaveLength(25);
  });

  it("returns an empty list when Steam explicitly reports no results", async () => {
    const games = await fetchSteamFreeGames(
      mockFetch(() => htmlResponse("<div>No results were returned by the search.</div>")),
    );

    expect(games).toEqual([]);
  });

  it("throws when the page cannot be parsed", async () => {
    await expect(
      fetchSteamFreeGames(mockFetch(() => htmlResponse("<html><body>Access denied</body></html>"))),
    ).rejects.toBeInstanceOf(SteamError);
  });

  it("throws with the status code when Steam fails", async () => {
    const fetchImpl = mockFetch(() => new Response("unavailable", { status: 503 }));

    await expect(fetchSteamFreeGames(fetchImpl)).rejects.toMatchObject({
      name: "SteamError",
      status: 503,
    });
  });

  it("uses the Netherlands storefront and English language", async () => {
    let requestedUrl = "";
    await fetchSteamFreeGames(
      mockFetch((url) => {
        requestedUrl = url;
        return htmlResponse(searchRow("10", "Alpha"));
      }),
    );

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("cc")).toBe("nl");
    expect(url.searchParams.get("l")).toBe("english");
    expect(url.searchParams.get("maxprice")).toBe("free");
    expect(url.searchParams.get("specials")).toBe("1");
  });
});

describe("isTemporarilyFree", () => {
  const details = (data: unknown) => jsonResponse({ "10": { success: true, data } });

  it("accepts a 100% discount even though Steam keeps the original final price", async () => {
    const fetchImpl = mockFetch(() =>
      details({ price_overview: { discount_percent: 100, initial: 975, final: 975 } }),
    );

    await expect(isTemporarilyFree("10", fetchImpl)).resolves.toBe(true);
  });

  it("accepts a 100% discount whose final price is zero", async () => {
    const fetchImpl = mockFetch(() =>
      details({ price_overview: { discount_percent: 100, initial: 975, final: 0 } }),
    );

    await expect(isTemporarilyFree("10", fetchImpl)).resolves.toBe(true);
  });

  it("rejects a 100% discount without a paid base price", async () => {
    const fetchImpl = mockFetch(() =>
      details({ price_overview: { discount_percent: 100, initial: 0, final: 0 } }),
    );

    await expect(isTemporarilyFree("10", fetchImpl)).resolves.toBe(false);
  });

  it("rejects dlc, soundtracks and other non-game app types", async () => {
    const fetchImpl = mockFetch(() =>
      details({ type: "dlc", price_overview: { discount_percent: 100, initial: 499, final: 499 } }),
    );

    await expect(isTemporarilyFree("10", fetchImpl)).resolves.toBe(false);
  });

  it("accepts games when the app type is reported", async () => {
    const fetchImpl = mockFetch(() =>
      details({ type: "game", price_overview: { discount_percent: 100, initial: 499, final: 499 } }),
    );

    await expect(isTemporarilyFree("10", fetchImpl)).resolves.toBe(true);
  });

  it("rejects a partial discount", async () => {
    const fetchImpl = mockFetch(() =>
      details({ price_overview: { discount_percent: 50, initial: 1999, final: 999 } }),
    );

    await expect(isTemporarilyFree("10", fetchImpl)).resolves.toBe(false);
  });

  it("rejects titles without price information (permanently free)", async () => {
    await expect(isTemporarilyFree("10", mockFetch(() => details({})))).resolves.toBe(false);
    await expect(isTemporarilyFree("10", mockFetch(() => details([])))).resolves.toBe(false);
  });

  it("rejects apps Steam marks as unsuccessful", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ "10": { success: false } }));

    await expect(isTemporarilyFree("10", fetchImpl)).resolves.toBe(false);
  });

  it("throws on a server error so the app is retried later", async () => {
    const fetchImpl = mockFetch(() => new Response("oops", { status: 500 }));

    await expect(isTemporarilyFree("10", fetchImpl)).rejects.toBeInstanceOf(SteamError);
  });

  it("queries the Netherlands/English price overview", async () => {
    let requestedUrl = "";
    await isTemporarilyFree(
      "10",
      mockFetch((url) => {
        requestedUrl = url;
        return details({ price_overview: { discount_percent: 100, final: 0 } });
      }),
    );

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("appids")).toBe("10");
    expect(url.searchParams.get("cc")).toBe("nl");
    expect(url.searchParams.get("l")).toBe("english");
    expect(url.searchParams.get("filters")).toBe("basic,price_overview");
  });
});
