export interface Env {
  SEEN_GAMES: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  /** Optional bearer token that enables the manual GET/POST /check endpoint. */
  MANUAL_TRIGGER_TOKEN?: string;
}

export interface GamePrice {
  /** Price shown before the discount, for example "9,75€". */
  original?: string;
  /** Price shown after the discount, for example "0,00€". */
  final?: string;
  discountPercent?: number;
}

export interface GameReview {
  /** Steam's summary, for example "Very Positive". */
  summary?: string;
  /** Share of positive reviews, for example 91. */
  percent?: number;
  /** Number of user reviews, for example 316. */
  count?: number;
  /** Drives the 👍/🤔/👎 indicator. */
  tone?: "positive" | "mixed" | "negative";
}

export interface SteamGame {
  appId: string;
  name: string;
  url: string;
  imageUrl?: string;
  platforms?: string[];
  releaseDate?: string;
  price?: GamePrice;
  review?: GameReview;
}

/**
 * Per-app state. `free` means Steam reported a 100%-off promo on the last
 * successful validation; `notifiedAt` is only set after Discord accepted the
 * message, so failed notifications are retried on the next run.
 */
export interface SeenGame {
  firstSeenAt: number;
  lastSeenAt: number;
  free?: boolean;
  notifiedAt?: number;
}

export type SeenGames = Record<string, SeenGame>;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  url: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  image?: { url: string };
}

export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}
