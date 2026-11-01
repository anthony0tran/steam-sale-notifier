# Steam Sale Notifier

[![CI](https://github.com/anthony0tran/steam-sale-notifier/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/anthony0tran/steam-sale-notifier/actions/workflows/ci.yml)
[![Deploy](https://github.com/anthony0tran/steam-sale-notifier/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/anthony0tran/steam-sale-notifier/actions/workflows/deploy.yml)

A Cloudflare Worker that checks Steam every 30 minutes for temporarily free
games (100%-off promotions) and posts new ones to a Discord channel.

```
Cloudflare Cron (*/30 * * * *)
        │
        ▼
Worker ──► Steam search (maxprice=free, specials=1, cc=nl, English)
        │        └──► appdetails: confirm 100% off + app type is "game"
        ├──► Workers KV: seen games (last seen, validated free, notified)
        └──► Discord webhook: batched embeds
```

## Requirements

- Node.js 22+ and npm (CI uses Node 22)
- A Cloudflare account with Workers + KV
- A Discord channel where you can create a webhook

## Setup

For a complete from-scratch walkthrough — new Cloudflare account, KV namespace,
Discord webhook, first deploy, and GitHub Actions secrets — see
[DEPLOYMENT.md](DEPLOYMENT.md).

```bash
npm install
```

### 1. Create the KV namespace

```bash
npx wrangler kv namespace create SEEN_GAMES
```

Copy the printed `id` into `wrangler.jsonc`, replacing `<KV_NAMESPACE_ID>`.

### 2. Create a Discord webhook

In Discord: **Channel settings → Integrations → Webhooks → New Webhook**, then
copy the webhook URL. Never commit it.

### 3. Store the webhook as a secret

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
```

For local development:

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with a test webhook URL
```

`.dev.vars` is git-ignored.

### 4. Run locally

```bash
npm run dev
```

Wrangler only exposes the scheduled handler in test mode. Trigger a run with:

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
```

(`/cdn-cgi/local/scheduled`, as written in the original PRD, does not exist.)

### 5. Deploy

```bash
npm run typecheck
npm test
npx wrangler deploy
npx wrangler tail          # watch the first scheduled runs
```

Pushes to `main` deploy automatically once the Cloudflare secrets are set up
(see [CI/CD](#cicd)).

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Local Worker with `--test-scheduled` |
| `npm test` | Vitest unit tests (66 tests) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy` | Deploy with Wrangler |
| `npm run tail` | Stream production logs |

## How detection works

1. **Search** — `store.steampowered.com/search/?maxprice=free&specials=1&supportedlang=english&cc=nl&l=english`,
   paginated up to 8 pages and deduplicated by app id.
2. **Parse** — each `a.search_result_row` with a single numeric `data-ds-appid`
   is normalized to `{ appId, name, url }` plus the capsule image, platforms,
   release date, price/discount and review summary when present. Bundle rows
   and rows without a title are skipped.
3. **Validate** — only *new or unresolved* candidates are sent to
   `appdetails?filters=basic,price_overview&cc=nl`. A game qualifies when:
   - `discount_percent === 100`, and
   - `initial > 0` (a paid game), and
   - `type` is absent or `"game"` (excludes DLC, soundtracks, demos, software).

   Steam's appdetails quirk: for 100%-off promos, `final` often stays equal to
   the original price (`{"discount_percent":100,"initial":975,"final":975}`,
   `final_formatted: "Free"`). The original PRD's `final === 0` check would
   reject every real promotion; this implementation does not use it.
4. **State** — validation results and "last seen" times are stored in one KV
   key:

   ```json
   {
     "570": { "firstSeenAt": 1793530000000, "lastSeenAt": 1793530000000, "free": true, "notifiedAt": 1793530000000 }
   }
   ```

5. **Notify** — games that are free and either have no successful notification
   or were last announced at least **30 days** ago are posted in batches of up
   to 10 embeds (Discord's limit). A game is marked notified only after Discord
   accepts the message, so failed posts are retried next run.

### State retention and cooldown

Entries whose `lastSeenAt` is older than **90 days** are pruned. A promotion
that ends and returns months later is therefore announced again instead of
being blocked forever by a monotonically growing ID list (a flaw in the
original plan).

A successfully announced game is not posted again for **30 days**
(`NOTIFICATION_COOLDOWN_MS`). After the cooldown, if the game is still or again
free, it is announced again and the cooldown restarts. This means a recurring
sale is re-announced roughly monthly; a new sale that starts inside the
remaining cooldown is not announced until the cooldown expires (and is missed if
it ends first). Reducing the constant changes the cooldown for all games.

The legacy PRD format `["570","730"]` is migrated automatically and treated as
already notified, so upgrading does not spam the channel.

### Discord embeds

Each announcement is built from the same search result row, so no extra
requests are made:

- capsule image
- title linked to the Steam store page
- platforms (`Windows · macOS · Linux`)
- release date
- price as `~~9,75€~~ **0,00€** -100%`
- review summary with 👍/🤔/👎, percentage and review count when Steam exposes it

The separate `appdetails` call is still used only to confirm the app is a
100%-off game and to exclude DLC, software and soundtracks.

## Manual trigger

The Worker has a token-protected endpoint that runs the same check as the cron:

```bash
curl -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  https://steam-sale-notifier.<subdomain>.workers.dev/check
```

Set the token once with `npx wrangler secret put MANUAL_TRIGGER_TOKEN` (any long
random string). `GET` and `POST` are accepted; the JSON response is the same
summary that appears in the logs. `GET /` returns a small health response.

If `MANUAL_TRIGGER_TOKEN` is not set, `/check` returns `503` and the cron keeps
working. The endpoint writes real KV state and posts to Discord, so avoid
calling it concurrently with another run; sequential calls are safe because
already-notified games are skipped.

## Tests

`npm test` covers:

- HTML parsing, entity decoding, bundle skipping, pagination/deduplication, and
  metadata extraction (image, platforms, release date, price, reviews)
- Discord payloads: batching, title truncation, strikethrough pricing, review
  tone, 429 retry and partial batch failure
- 100%-off validation, including Steam's `final` quirk and non-game app types
- KV persistence, legacy migration, corrupt state, 90-day pruning and the
  30-day notification cooldown
- End-to-end `runCheck`: empty state, dedupe on the second run, Discord retry,
  validation retry, Steam failure (no KV write)
- HTTP handling: health response, bearer-token auth, 401/503/405 paths, manual
  trigger summary, and the `scheduled` handler

CI runs the same typecheck, test and build steps on every push and pull request.

## CI/CD

Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Trigger | Steps |
|---|---|---|
| [`ci.yml`](https://github.com/anthony0tran/steam-sale-notifier/blob/main/.github/workflows/ci.yml) | Push to `main`, pull request, manual | `npm ci` → typecheck → tests → `wrangler deploy --dry-run` |
| [`deploy.yml`](https://github.com/anthony0tran/steam-sale-notifier/blob/main/.github/workflows/deploy.yml) | Push to `main`, manual | typecheck → tests → config preflight → `wrangler deploy` |

The deploy workflow skips documentation-only pushes (`**.md`, `LICENSE`,
`PRD.txt`) and never cancels an in-flight deployment.

### Required repository secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → **Workers & Pages** → Account ID |
| `CLOUDFLARE_API_TOKEN` | <https://dash.cloudflare.com/profile/api-tokens> |

Create the token from the **Edit Cloudflare Workers** template, or grant
**Workers Scripts: Edit** and **Workers KV Storage: Edit** manually.

The Discord webhook is deliberately not part of CI — it stays on the Worker as
a secret:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
```

The deploy job fails early with a clear message if `wrangler.jsonc` still
contains `<KV_NAMESPACE_ID>` or if either Cloudflare secret is missing.

## Operational notes

- **First run announces everything currently free.** On a cold KV, all current
  promotions are new. Use a test channel for the first deploy or pre-seed the
  state key if you prefer a silent baseline.
- **At-least-once delivery.** A crash between Discord accepting a message and
  KV being written can produce a duplicate. KV is eventually consistent; a
  single cron job every 30 minutes makes this rare.
- **Steam is not an API.** The search HTML and `appdetails` responses can
  change. An unparseable page raises `SteamError` rather than reporting "no
  games", so breakage is visible in the logs. If a candidate cannot be priced,
  it stays unresolved and is retried next run.
- **DLC/software are filtered** by `appdetails.type`. Genres are not filtered.
- **Discord limits.** Messages contain at most 10 embeds; 429s honour
  `retry_after` (capped at 5 s, three attempts per batch).
- **Secrets.** `DISCORD_WEBHOOK_URL` comes from `wrangler secret` in production
  and `.dev.vars` locally. Never place it in `wrangler.jsonc`.

## Project layout

```
src/
  index.ts     scheduled handler + orchestration
  steam.ts     search fetch/parse, appdetails validation
  state.ts     KV state model, legacy migration, pruning
  discord.ts   embed formatting, batching, retries
  types.ts     Env / SteamGame / state / payload types
  utils.ts     chunk, delay, error formatting
test/          vitest suites + in-memory KV/fetch helpers
wrangler.jsonc cron trigger and KV binding
```

## Possible next steps

- Genre filtering and discount end times in embeds
- Durable Object instead of KV for atomic dedupe and a run lock
- Per-token rate limiting for the manual endpoint
- Test coverage reports in CI and tag-based release deployments
