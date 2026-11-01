import type {
  DiscordEmbed,
  DiscordEmbedField,
  DiscordWebhookPayload,
  Env,
  GamePrice,
  GameReview,
  SteamGame,
} from "./types";
import { chunk, delay, errorMessage } from "./utils";

const EMBED_COLOR = 3_066_993;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_TITLE_LENGTH = 256;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_LENGTH = 500;

const REVIEW_TONE_EMOJI: Record<NonNullable<GameReview["tone"]>, string> = {
  positive: "👍",
  mixed: "🤔",
  negative: "👎",
};

export class DiscordError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
  }
}

export interface DiscordSendResult {
  sentAppIds: string[];
  failedAppIds: string[];
}

export function formatEmbed(game: SteamGame): DiscordEmbed {
  const embed: DiscordEmbed = {
    title: truncate(game.name, MAX_TITLE_LENGTH),
    url: game.url,
    description: "Now temporarily free on Steam.",
    color: EMBED_COLOR,
  };

  const fields = buildFields(game);
  if (fields.length > 0) {
    embed.fields = fields;
  }

  if (game.imageUrl) {
    embed.image = { url: game.imageUrl };
  }

  return embed;
}

function buildFields(game: SteamGame): DiscordEmbedField[] {
  const fields: DiscordEmbedField[] = [];

  if (game.platforms && game.platforms.length > 0) {
    fields.push({
      name: "Platforms",
      value: game.platforms.join(" · "),
      inline: true,
    });
  }

  if (game.releaseDate) {
    fields.push({
      name: "Release date",
      value: game.releaseDate,
      inline: true,
    });
  }

  const price = formatPrice(game.price);
  if (price) {
    fields.push({ name: "Price", value: price, inline: true });
  }

  const review = formatReview(game.review);
  if (review) {
    fields.push({ name: "Reviews", value: review, inline: false });
  }

  return fields;
}

function formatPrice(price: GamePrice | undefined): string | undefined {
  if (!price) {
    return undefined;
  }

  const parts: string[] = [];
  if (price.original && price.original !== price.final) {
    parts.push(`~~${price.original}~~`);
  }
  if (price.final) {
    parts.push(`**${price.final}**`);
  }
  if (price.discountPercent !== undefined && price.discountPercent > 0) {
    parts.push(`-${price.discountPercent}%`);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatReview(review: GameReview | undefined): string | undefined {
  if (!review) {
    return undefined;
  }

  const headline = [
    review.tone ? REVIEW_TONE_EMOJI[review.tone] : undefined,
    review.summary,
  ]
    .filter(Boolean)
    .join(" ");

  const detail: string[] = [];
  if (review.percent !== undefined) {
    detail.push(`${review.percent}%`);
  }
  if (review.count !== undefined) {
    detail.push(`${review.count.toLocaleString("en-US")} reviews`);
  }

  return [headline, detail.join(" · ")].filter(Boolean).join(" · ") || undefined;
}

export function buildDiscordPayloads(games: readonly SteamGame[]): DiscordWebhookPayload[] {
  return chunk(games, MAX_EMBEDS_PER_MESSAGE).map((batch) => ({
    embeds: batch.map(formatEmbed),
  }));
}

async function readBody(response: Response): Promise<string> {
  try {
    return truncate(await response.text(), MAX_ERROR_BODY_LENGTH);
  } catch {
    return "";
  }
}

function retryAfterMs(response: Response, body: string): number {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "retry_after" in parsed) {
      const seconds = (parsed as { retry_after?: unknown }).retry_after;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }
  } catch {
    // Body was not JSON; fall through to the default backoff.
  }

  return 1000;
}

async function postWithRetry(
  webhookUrl: string,
  payload: DiscordWebhookPayload,
  fetchImpl: typeof fetch,
): Promise<void> {
  const target = new URL(webhookUrl);
  // `wait=true` makes Discord return the created message (and errors) instead
  // of an empty 204, which gives us an unambiguous success signal.
  target.searchParams.set("wait", "true");

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(target.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      lastError = cause;
      if (attempt < MAX_ATTEMPTS) {
        await delay(500 * attempt);
      }
      continue;
    }

    if (response.ok) {
      return;
    }

    const body = await readBody(response);

    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      await delay(Math.min(retryAfterMs(response, body), MAX_RETRY_DELAY_MS));
      lastError = new DiscordError(`Discord rate limited (429): ${body}`, 429);
      continue;
    }

    if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
      await delay(500 * attempt);
      lastError = new DiscordError(
        `Discord webhook returned HTTP ${response.status}: ${body}`,
        response.status,
      );
      continue;
    }

    throw new DiscordError(
      `Discord webhook returned HTTP ${response.status}: ${body}`,
      response.status,
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new DiscordError("Discord webhook request failed after retries");
}

/**
 * Post new games in batches of ten embeds. Returns the ids Discord accepted;
 * batches that failed stay unknown so the next scheduled run retries them
 * (at-least-once semantics).
 */
export async function sendDiscordNotifications(
  env: Env,
  games: readonly SteamGame[],
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordSendResult> {
  const result: DiscordSendResult = { sentAppIds: [], failedAppIds: [] };
  if (games.length === 0) {
    return result;
  }

  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new DiscordError("DISCORD_WEBHOOK_URL is not configured");
  }

  for (const batch of chunk(games, MAX_EMBEDS_PER_MESSAGE)) {
    const payload: DiscordWebhookPayload = { embeds: batch.map(formatEmbed) };

    try {
      await postWithRetry(webhookUrl, payload, fetchImpl);
      result.sentAppIds.push(...batch.map((game) => game.appId));
    } catch (cause) {
      console.error(
        `Discord notification failed for ${batch.length} game(s): ${errorMessage(cause)}`,
      );
      result.failedAppIds.push(...batch.map((game) => game.appId));
    }
  }

  return result;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}
