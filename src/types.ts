export interface Env {
  SEEN_GAMES: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  /** Optional bearer token that enables the manual GET/POST /check endpoint. */
  MANUAL_TRIGGER_TOKEN?: string;
  /**
   * Optional JSON array of Discord users to mention when they do not own a
   * newly announced game. See `MentionTarget`.
   */
  MENTION_USERS?: string;
  /** Steam Web API key used to read the configured users' game libraries. */
  STEAM_API_KEY?: string;
}

/**
 * One entry in the `MENTION_USERS` JSON array. `discordId` is the numeric
 * Discord user id and is required for a real ping; `discordUsername` is used
 * as readable fallback text when no id is configured.
 */
export interface MentionTarget {
  discordId?: string;
  discordUsername?: string;
  /** SteamID64, vanity name, or a steamcommunity.com profile URL. */
  steamId: string;
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

/** App types tracked by the worker. Only games and DLC can be announced. */
export type SteamAppKind = "game" | "dlc" | "other";

export interface PromotionInfo {
  /** Whether the app currently has a paid 100%-off promotion. */
  free: boolean;
  kind?: SteamAppKind;
  /** For DLC, the app id of the base game it belongs to. */
  baseAppId?: string;
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
  /** App kind recorded when the promotion was validated. */
  kind?: SteamAppKind;
  /** For DLC, the base game app id recorded at validation time. */
  baseAppId?: string;
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
  /** Optional message text used for user mentions. */
  content?: string;
  embeds: DiscordEmbed[];
  allowed_mentions?: {
    parse?: Array<"roles" | "users" | "everyone">;
    users?: string[];
  };
}
