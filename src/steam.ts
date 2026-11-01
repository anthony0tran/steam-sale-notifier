import type { GamePrice, GameReview, SteamGame } from "./types";
import { errorMessage } from "./utils";

const SEARCH_ENDPOINT = "https://store.steampowered.com/search/";
const APPDETAILS_ENDPOINT = "https://store.steampowered.com/api/appdetails";

/** Steam returns 25 results per search page unless told otherwise. */
const PAGE_SIZE = 25;
const MAX_PAGES = 8;
const REQUEST_TIMEOUT_MS = 15_000;

const REQUEST_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "steam-sale-notifier/0.1 (personal Discord notifier)",
};

const NO_RESULTS_RE = /no results were returned/i;
const ROW_RE = /<a\b(?=[^>]*\bdata-ds-appid=")[^>]*>[\s\S]*?<\/a>/gi;
const APP_ID_RE = /data-ds-appid="([^"]+)"/i;
const TITLE_RE = /<span\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
const IMAGE_RE = /<img\b[^>]*\bsrc="([^"]+)"/i;
const PLATFORM_RE = /\bplatform_img\s+(win|mac|linux)\b/gi;
const RELEASE_RE =
  /<div\b[^>]*class="[^"]*\bsearch_released\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const DISCOUNT_PCT_RE =
  /<div\b[^>]*class="[^"]*\bdiscount_pct\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const ORIGINAL_PRICE_RE =
  /<div\b[^>]*class="[^"]*\bdiscount_original_price\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const FINAL_PRICE_RE =
  /<div\b[^>]*class="[^"]*\bdiscount_final_price\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const REVIEW_TAG_RE =
  /<span\b[^>]*class="[^"]*\bsearch_review_summary\b[^"]*"[^>]*>/i;
const TOOLTIP_RE = /data-tooltip-html="([^"]*)"/i;
const CLASS_RE = /class="([^"]*)"/i;

const PLATFORM_LABELS: Record<string, string> = {
  win: "Windows",
  mac: "macOS",
  linux: "Linux",
};
const PLATFORM_ORDER = ["Windows", "macOS", "Linux"];

export class SteamError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SteamError";
    this.status = status;
  }
}

interface PriceOverview {
  discount_percent?: number;
  initial?: number;
  final?: number;
}

interface AppDetailsData {
  type?: string;
  price_overview?: PriceOverview;
}

interface AppDetailsEntry {
  success?: boolean;
  data?: AppDetailsData | unknown[] | null;
}

function buildSearchUrl(page: number): string {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("maxprice", "free");
  url.searchParams.set("specials", "1");
  url.searchParams.set("supportedlang", "english");
  // Country/currency for the Netherlands. The original PRD used `ndl=1`,
  // which is not a documented country selector; `cc` is.
  url.searchParams.set("cc", "nl");
  url.searchParams.set("l", "english");
  if (page > 0) {
    url.searchParams.set("start", String(page * PAGE_SIZE));
  }
  return url.toString();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function cleanName(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractName(row: string): string | undefined {
  const match = TITLE_RE.exec(row);
  if (!match?.[1]) {
    return undefined;
  }

  const name = cleanName(match[1]);
  return name.length > 0 ? name : undefined;
}

function extractImageUrl(row: string): string | undefined {
  const src = IMAGE_RE.exec(row)?.[1]?.trim();
  return src ? decodeEntities(src) : undefined;
}

function extractPlatforms(row: string): string[] | undefined {
  const found = new Set<string>();

  for (const match of row.matchAll(PLATFORM_RE)) {
    const label = PLATFORM_LABELS[match[1]?.toLowerCase() ?? ""];
    if (label) {
      found.add(label);
    }
  }

  if (found.size === 0) {
    return undefined;
  }
  return PLATFORM_ORDER.filter((platform) => found.has(platform));
}

function extractReleaseDate(row: string): string | undefined {
  const match = RELEASE_RE.exec(row)?.[1];
  if (!match) {
    return undefined;
  }

  const releaseDate = cleanName(match);
  return releaseDate.length > 0 ? releaseDate : undefined;
}

function extractPrice(row: string): GamePrice | undefined {
  const original = cleanName(ORIGINAL_PRICE_RE.exec(row)?.[1] ?? "");
  const final = cleanName(FINAL_PRICE_RE.exec(row)?.[1] ?? "");
  if (!original && !final) {
    return undefined;
  }

  const discountText = cleanName(DISCOUNT_PCT_RE.exec(row)?.[1] ?? "");
  const discountPercent = Number.parseInt(discountText.replace(/[^\d]/g, ""), 10);

  const price: GamePrice = {};
  if (original) {
    price.original = original;
  }
  if (final) {
    price.final = final;
  }
  if (Number.isFinite(discountPercent)) {
    price.discountPercent = discountPercent;
  }
  return price;
}

function extractReview(row: string): GameReview | undefined {
  const tag = REVIEW_TAG_RE.exec(row)?.[0];
  if (!tag) {
    return undefined;
  }

  let summary: string | undefined;
  let percent: number | undefined;
  let count: number | undefined;

  const tooltip = TOOLTIP_RE.exec(tag)?.[1];
  if (tooltip) {
    const decoded = decodeEntities(tooltip);
    const [summaryPart = "", ...details] = decoded.split(/<br\s*\/?>/i);

    const cleanedSummary = cleanName(summaryPart);
    if (cleanedSummary) {
      summary = cleanedSummary;
    }

    const detail = details.join(" ");
    const percentMatch = /(\d+)%/.exec(detail);
    if (percentMatch?.[1]) {
      percent = Number.parseInt(percentMatch[1], 10);
    }

    const countMatch = /of the ([\d,]+) user reviews/i.exec(detail);
    if (countMatch?.[1]) {
      count = Number.parseInt(countMatch[1].replace(/,/g, ""), 10);
    }
  }

  const classValue = CLASS_RE.exec(tag)?.[1] ?? "";
  const toneValue = /\b(positive|mixed|negative)\b/i.exec(classValue)?.[1]?.toLowerCase();
  const tone =
    toneValue === "positive" || toneValue === "mixed" || toneValue === "negative"
      ? toneValue
      : undefined;

  if (!summary && !tone) {
    return undefined;
  }

  const review: GameReview = {};
  if (summary) {
    review.summary = summary;
  }
  if (percent !== undefined && Number.isFinite(percent)) {
    review.percent = percent;
  }
  if (count !== undefined && Number.isFinite(count)) {
    review.count = count;
  }
  if (tone) {
    review.tone = tone;
  }
  return review;
}

/**
 * Extract games from a Steam search results page.
 *
 * Steam renders each result as an `<a class="search_result_row"
 * data-ds-appid="...">` block with the title in a nested `<span class="title">`.
 * Bundle rows have no single app id and are skipped.
 */
export function parseSteamSearchHtml(html: string): SteamGame[] {
  const games: SteamGame[] = [];
  const seen = new Set<string>();

  for (const row of html.match(ROW_RE) ?? []) {
    const appIdMatch = APP_ID_RE.exec(row);
    const rawAppId = appIdMatch?.[1]?.trim();
    // "123,456" is a package/bundle, not a single game.
    if (!rawAppId || !/^\d+$/.test(rawAppId)) {
      continue;
    }
    if (seen.has(rawAppId)) {
      continue;
    }

    const name = extractName(row);
    if (!name) {
      continue;
    }

    seen.add(rawAppId);

    const game: SteamGame = {
      appId: rawAppId,
      name,
      url: `https://store.steampowered.com/app/${rawAppId}/`,
    };

    const imageUrl = extractImageUrl(row);
    if (imageUrl) {
      game.imageUrl = imageUrl;
    }

    const platforms = extractPlatforms(row);
    if (platforms) {
      game.platforms = platforms;
    }

    const releaseDate = extractReleaseDate(row);
    if (releaseDate) {
      game.releaseDate = releaseDate;
    }

    const price = extractPrice(row);
    if (price) {
      game.price = price;
    }

    const review = extractReview(row);
    if (review) {
      game.review = review;
    }

    games.push(game);
  }

  return games;
}

async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SteamError(`Steam search request failed: ${errorMessage(cause)}`);
  }

  if (!response.ok) {
    throw new SteamError(`Steam search returned HTTP ${response.status}`, response.status);
  }

  try {
    return await response.text();
  } catch (cause) {
    throw new SteamError(`Steam search response could not be read: ${errorMessage(cause)}`);
  }
}

/**
 * Fetch every page of the filtered Steam search and return deduplicated games.
 * Throws when the page cannot be fetched or no results can be parsed, so a
 * markup change is visible in the logs instead of looking like "nothing free".
 */
export async function fetchSteamFreeGames(fetchImpl: typeof fetch = fetch): Promise<SteamGame[]> {
  const games: SteamGame[] = [];
  const seenIds = new Set<string>();
  let sawNoResults = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await fetchHtml(buildSearchUrl(page), fetchImpl);

    if (NO_RESULTS_RE.test(html)) {
      sawNoResults = true;
      break;
    }

    const pageGames = parseSteamSearchHtml(html);
    let added = 0;
    for (const game of pageGames) {
      if (seenIds.has(game.appId)) {
        continue;
      }
      seenIds.add(game.appId);
      games.push(game);
      added++;
    }

    // Shorter page means this was the last page. No new ids means the offset
    // was ignored or the same page was served twice; stop to avoid looping.
    if (pageGames.length < PAGE_SIZE || added === 0) {
      break;
    }
  }

  if (games.length === 0 && !sawNoResults) {
    throw new SteamError("Steam search returned no parsable game rows (markup may have changed)");
  }

  return games;
}

/**
 * Ask Steam whether an app is currently a temporarily free game.
 *
 * Permanently free-to-play titles have no `price_overview` (or a 0% discount),
 * so requiring `discount_percent === 100` filters them out. Note that Steam
 * reports `final` as the original amount for 100%-off promos (for example
 * `{ discount_percent: 100, initial: 975, final: 975 }` with
 * `final_formatted: "Free"`), so `final === 0` is *not* a usable check.
 * Requiring a non-zero `initial` excludes free-to-own apps with no base price.
 * DLC, soundtracks, demos and software are skipped so the channel only gets
 * actual games.
 *
 * Network/server failures throw; the caller retries on a later run.
 */
export async function isTemporarilyFree(
  appId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = new URL(APPDETAILS_ENDPOINT);
  url.searchParams.set("appids", appId);
  url.searchParams.set("cc", "nl");
  url.searchParams.set("l", "english");
  url.searchParams.set("filters", "basic,price_overview");

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SteamError(`Steam appdetails request failed for ${appId}: ${errorMessage(cause)}`);
  }

  if (!response.ok) {
    throw new SteamError(
      `Steam appdetails returned HTTP ${response.status} for ${appId}`,
      response.status,
    );
  }

  let payload: Record<string, AppDetailsEntry>;
  try {
    payload = (await response.json()) as Record<string, AppDetailsEntry>;
  } catch (cause) {
    throw new SteamError(`Steam appdetails response was not JSON for ${appId}: ${errorMessage(cause)}`);
  }

  const entry = payload[appId];
  if (entry?.success !== true) {
    // Steam says the app is unavailable; treat it as not a promotion.
    return false;
  }

  const data = entry.data;
  if (!data || Array.isArray(data)) {
    return false;
  }

  const details = data as AppDetailsData;
  // "game" is the only type we announce; skip "dlc", "music", "demo", etc.
  // If Steam ever omits the field, fall back to the price check alone.
  if (details.type !== undefined && details.type !== "game") {
    return false;
  }

  const price = details.price_overview;
  if (!price) {
    return false;
  }

  const discountPercent = price.discount_percent ?? 0;
  const initial = price.initial ?? 0;
  return discountPercent === 100 && initial > 0;
}
