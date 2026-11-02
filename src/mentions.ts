import type { MentionTarget } from "./types";

const DISCORD_ID_RE = /^\d{17,20}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripAtSign(value: string): string {
  return value.replace(/^@+/, "");
}

/**
 * Parse the `MENTION_USERS` runtime variable.
 *
 * Expected shape:
 * ```json
 * [
 *   { "discordId": "123456789012345678", "discordUsername": "alice", "steamId": "7656119..." }
 * ]
 * ```
 *
 * `discordId` is preferred because Discord only turns `<@id>` into a real
 * mention. `discordUsername` is kept as a human-readable fallback. `steamId`
 * may be a SteamID64, a vanity name, or a steamcommunity.com profile URL.
 *
 * Invalid JSON or invalid entries are ignored with a warning so a typo cannot
 * stop the notifier from posting games.
 */
export function parseMentionTargets(raw: string | undefined): MentionTarget[] {
  if (!raw?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("Ignoring MENTION_USERS: value is not valid JSON");
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn("Ignoring MENTION_USERS: expected a JSON array");
    return [];
  }

  const targets: MentionTarget[] = [];
  const seen = new Set<string>();

  for (const [index, value] of parsed.entries()) {
    if (!isRecord(value)) {
      console.warn(`Ignoring MENTION_USERS[${index}]: expected an object`);
      continue;
    }

    const discordIdRaw = readString(value.discordId) ?? readString(value.discord);
    const discordUsernameRaw =
      readString(value.discordUsername) ?? readString(value.username);
    const steamId =
      readString(value.steamId) ??
      readString(value.steam) ??
      readString(value.steamVanity);

    if (!steamId) {
      console.warn(`Ignoring MENTION_USERS[${index}]: missing steamId`);
      continue;
    }

    const target: MentionTarget = { steamId };

    if (discordIdRaw) {
      if (!DISCORD_ID_RE.test(discordIdRaw)) {
        console.warn(
          `Ignoring MENTION_USERS[${index}].discordId: expected a 17-20 digit Discord user id`,
        );
      } else {
        target.discordId = discordIdRaw;
      }
    }

    const discordUsername = discordUsernameRaw ? stripAtSign(discordUsernameRaw) : undefined;
    if (discordUsername) {
      target.discordUsername = discordUsername;
    }

    if (!target.discordId && !target.discordUsername) {
      console.warn(
        `Ignoring MENTION_USERS[${index}]: needs a discordId or discordUsername`,
      );
      continue;
    }

    const key = `${target.discordId ?? target.discordUsername}:${target.steamId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
  }

  return targets;
}

/** Render a target as Discord mention markup, falling back to plain text. */
export function formatMention(target: MentionTarget): string {
  if (target.discordId) {
    return `<@${target.discordId}>`;
  }
  return `@${target.discordUsername ?? target.steamId}`;
}

/** A short label for logs without exposing library details. */
export function mentionLabel(target: MentionTarget): string {
  return target.discordUsername ?? target.discordId ?? target.steamId;
}
