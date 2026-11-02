import { errorMessage } from "./utils";

const API_BASE = "https://api.steampowered.com";
const RESOLVE_VANITY_ENDPOINT = `${API_BASE}/ISteamUser/ResolveVanityURL/v1/`;
const OWNED_GAMES_ENDPOINT = `${API_BASE}/IPlayerService/GetOwnedGames/v1/`;
const REQUEST_TIMEOUT_MS = 15_000;

const STEAM_ID_RE = /^\d{17}$/;
const PROFILE_ID_RE = /\/profiles\/(\d{17})(?:[/?#]|$)/i;
const VANITY_PROFILE_RE = /\/id\/([^/?#]+)/i;

export class SteamLibraryError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SteamLibraryError";
    this.status = status;
  }
}

interface ResolveVanityResponse {
  response?: {
    success?: number;
    steamid?: string;
    message?: string;
  };
}

interface OwnedGamesResponse {
  response?: {
    game_count?: number;
    games?: Array<{ appid?: number }>;
  };
}

async function fetchJson<T>(
  url: URL,
  fetchImpl: typeof fetch,
  context: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SteamLibraryError(`${context} request failed: ${errorMessage(cause)}`);
  }

  if (!response.ok) {
    throw new SteamLibraryError(
      `${context} returned HTTP ${response.status}`,
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new SteamLibraryError(`${context} response was not JSON: ${errorMessage(cause)}`);
  }
}

/**
 * Turn a configured library reference into a SteamID64.
 *
 * Numeric SteamID64 values and profile URLs are resolved locally. Vanity names
 * fall back to Steam's ResolveVanityURL endpoint, which needs the API key.
 */
export async function resolveSteamId(
  value: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const trimmed = value.trim();

  const profileMatch = PROFILE_ID_RE.exec(trimmed);
  if (profileMatch?.[1]) {
    return profileMatch[1];
  }

  if (STEAM_ID_RE.test(trimmed)) {
    return trimmed;
  }

  const vanityMatch = VANITY_PROFILE_RE.exec(trimmed);
  const vanity = vanityMatch?.[1]
    ? decodeURIComponent(vanityMatch[1])
    : trimmed;

  if (!vanity) {
    throw new SteamLibraryError(`Could not resolve Steam library reference "${value}"`);
  }

  const url = new URL(RESOLVE_VANITY_ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("vanityurl", vanity);
  url.searchParams.set("format", "json");

  const payload = await fetchJson<ResolveVanityResponse>(
    url,
    fetchImpl,
    "Steam vanity resolution",
  );

  const steamId = payload.response?.steamid;
  if (payload.response?.success !== 1 || !steamId) {
    const message = payload.response?.message ?? "profile not found";
    throw new SteamLibraryError(`Could not resolve Steam vanity "${vanity}": ${message}`);
  }

  return steamId;
}

/**
 * Read the app ids in a public Steam library.
 *
 * An empty response usually means the profile's game details are private; that
 * is treated as an error rather than "owns nothing" so the caller does not
 * mention someone by mistake.
 */
export async function fetchOwnedAppIds(
  library: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const steamId = await resolveSteamId(library, apiKey, fetchImpl);

  const url = new URL(OWNED_GAMES_ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId);
  url.searchParams.set("include_appinfo", "0");
  url.searchParams.set("include_played_free_games", "1");
  url.searchParams.set("format", "json");

  const payload = await fetchJson<OwnedGamesResponse>(
    url,
    fetchImpl,
    "Steam owned games",
  );

  const response = payload.response;
  if (!response || typeof response.game_count !== "number") {
    throw new SteamLibraryError(
      `Steam returned no library for ${steamId}; the profile's game details may be private`,
    );
  }

  const appIds = new Set<string>();
  for (const game of response.games ?? []) {
    if (typeof game.appid === "number" && Number.isFinite(game.appid)) {
      appIds.add(String(game.appid));
    }
  }

  return appIds;
}
