export interface Env {
  SEEN_GAMES: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
}

export interface SteamGame {
  appId: string;
  name: string;
  url: string;
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

export interface DiscordEmbed {
  title: string;
  url: string;
  description?: string;
  color?: number;
}

export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}
