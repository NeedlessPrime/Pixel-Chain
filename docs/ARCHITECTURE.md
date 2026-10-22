# $PIXEL — architecture & contract

A shared pixel-war canvas (r/place style) for holders of the $PIXEL Solana token.
Seasons are ephemeral: one week, then the canvas freezes, the $PIXEL logo is
stamped on it, it goes to the Hall of Fame with its timelapse, and a new season
starts from an empty canvas.

This document is the **contract** between `server/` and `web/`. Types live in
`shared/src/protocol.ts` and are the source of truth; this file explains the
behaviour behind them. UI text is **French**; code, comments and logs are English.

## Game rules

| Rule | Value (default, all configurable) |
|---|---|
| Who can paint | Any wallet holding at least the lowest tier (`shared/src/tiers.ts`) |
| Cooldown | By $PIXEL held: ≥1 M → 5 s, ≥100 k → 30 s, ≥10 k → 60 s. **60 s max**, always |
| Signing | Wallet signs **one** free message at login → session token (24 h). No popup per pixel |
| Balance check | Read on Solana (`getTokenAccountsByOwner`, by mint) and cached 30 s per wallet. If the player sold, the next refresh drops their tier |
| Season | 7 days. Last 24 h = **chaos**: cooldowns × 0.5 |
| Season end | Canvas freezes, **$PIXEL logo stamped** (bottom-right by default), PNG + timelapse archived to the Hall of Fame, 60 min break, then new season with the next theme and an empty canvas. Cooldowns and stats reset |
| Factions | Optional tag a player picks (2–16 chars). Leaderboard = pixels currently on the canvas per faction (territory). Can change at most once per hour; their pixels follow them |
| Prizes | None. Status and visibility only (no lottery) |
| Moderation | Players report an area; admin can wipe a rectangle, ban a wallet (optionally erasing all its pixels), end the season, resize the canvas |
| Mock mode | `MODE=mock`: balances are fake (default 0, set via `/api/dev/balance`), and the web app offers a "Dev wallet" (in-browser keypair) so everything can be tested before the coin launches |

## Repository layout

```
shared/   types + pure logic used by both sides (palette, tiers, login message, timelapse codec, protocol)
server/   Node 22 + TypeScript (run with tsx) — Fastify REST + WebSocket, in-memory state, file persistence
web/      Vite + vanilla TypeScript — canvas, wallet connect, HUD, Hall of Fame, admin page
docs/     this file
```

`@pixel/shared` exports TypeScript source (`shared/src/index.ts`); both tsx and
Vite compile it. Dependencies are already declared in each `package.json` and
installed by `npm install` at the root — avoid adding new ones.

## Server

### Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `MODE` | `mock` | `mock` or `live` |
| `DATA_DIR` | `./data` | persistence directory |
| `PUBLIC_DOMAIN` | request `Host` | domain written in the login message |
| `SESSION_SECRET` | random, persisted in `DATA_DIR/secret` | HMAC key for session tokens |
| `ADMIN_TOKEN` | unset → admin API disabled | sent as `x-admin-token` |
| `TOKEN_SYMBOL` | `$PIXEL` | |
| `TOKEN_MINT` | unset | required when `MODE=live` |
| `BUY_URL` | `https://pump.fun/coin/<mint>` if mint set | |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | use a paid RPC (Helius…) in prod |
| `BALANCE_TTL_MS` | `30000` | balance cache per wallet |
| `TIERS` | `DEFAULT_TIERS` | JSON array, validated with `validateTiers` |
| `CANVAS_WIDTH` / `CANVAS_HEIGHT` | `200` / `200` | size of a new season's canvas (≤ `MAX_CANVAS_SIZE`) |
| `SEASON_DAYS` | `7` | may be fractional (tests) |
| `SEASON_BREAK_MINUTES` | `60` | frozen showcase between seasons |
| `CHAOS_HOURS` / `CHAOS_FACTOR` | `24` / `0.5` | |
| `SEASON_THEMES` | `Les mèmes de Solana\|Pixel libre\|…` | `\|`-separated, cycled |
| `FACTIONS` | empty | `\|`-separated suggestions |
| `LOGO_PATH` | `server/assets/logo.png` if it exists | PNG stamped at season end (transparent pixels skipped, colours snapped to the palette). Fallback: built-in pixel-font "$PIXEL" text |
| `LOGO_POSITION` | `bottom-right` | `bottom-right` or `center` |
| `WEB_DIST` | `../web/dist` | static files served in production |

### State and persistence

In memory, per season:
- `colors: Uint8Array(w*h)` — palette index or `EMPTY` (255)
- `owners: Uint32Array(w*h)` — 0 = nobody, 1 = system ($PIXEL logo), n ≥ 2 = player id
- `times: Uint32Array(w*h)` — seconds since season start
- players: id ↔ wallet, faction, factionChangedAt, placed (this season), owned (current pixels), nextPlaceAt
- `seq` — global pixel sequence number, +1 per pixel change (placements, wipes, logo)
- placement log for the timelapse (append-only, `x,y,c` + a marker when a moderation wipe happens)

Persisted under `DATA_DIR` with atomic writes (write tmp + rename), every 10 s
when dirty and on SIGINT/SIGTERM: `state.json`, `canvas.bin`, `owners.bin`,
`times.bin`, `log-<seasonId>.bin`; archives in `archive/<seasonId>/{meta.json,image.png,timelapse.bin}`.
Restart must restore the exact canvas, season and cooldowns.

### Placement (hot path, O(1))

`place(wallet, x, y, c)` checks, in order: authenticated → season `live` →
in bounds → valid colour → not banned → balance tier (cached balance; refresh
when older than `BALANCE_TTL_MS`; on RPC failure use the stale value if < 5 min
old, else `rpc_unavailable`) → `now >= nextPlaceAt` else `cooldown` (with
`nextPlaceAt`). Then writes the cell, updates owner counts (previous owner
`owned--`), `nextPlaceAt = now + effectiveCooldownMs`, appends to the log,
queues the broadcast. Painting the same colour over your own pixel is allowed
(costs a cooldown). Per-socket message rate limit: 10 msg/s, frame ≤ 1 KB.

### Seasons

A timer (every second) drives transitions:
- `now >= chaos.startsAt` → chaos active, broadcast `season` + `me` to authed sockets.
- `now >= endsAt` → status `frozen`, stamp logo (as system pixels, logged + broadcast as `px`),
  archive (PNG via pngjs with EMPTY drawn as `EMPTY_COLOR`, timelapse with
  **moderated content removed**: placement records whose pixel was later erased by an
  admin wipe/ban are dropped), `nextSeasonAt = now + break`, broadcast `season`.
- `now >= nextSeasonAt` → new season (number+1, next theme, `CANVAS_WIDTH×HEIGHT`,
  empty canvas, players' placed/owned/nextPlaceAt reset, factions kept), broadcast `season` + `reload`.

The clock must be injectable (`now()` function) so tests can fast-forward.

### REST API (JSON; errors are `ApiError` with HTTP 4xx/5xx)

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/health` | – | `{ ok: true }` |
| `GET /api/config` | – | `PublicConfig` |
| `GET /api/canvas` | – | `application/octet-stream`, `w*h` bytes row-major. Headers `X-Canvas-Width`, `X-Canvas-Height`, `X-Canvas-Seq` (seq of the last change included), `Cache-Control: no-store` |
| `GET /api/pixel?x=&y=` | – | `PixelInfo` |
| `GET /api/leaderboard` | – | `Leaderboard` |
| `POST /api/auth/nonce` | – | `NonceRequest` → `NonceResponse` (nonce single-use, expires in 5 min, max 5 outstanding per wallet) |
| `POST /api/auth/verify` | – | `VerifyRequest` → `VerifyResponse`. Verifies the ed25519 signature (tweetnacl) of the exact issued message with the wallet's public key |
| `GET /api/me[?refresh=1]` | Bearer | `MeInfo`; `refresh=1` forces a balance re-read (max once per 10 s per wallet) |
| `POST /api/me/faction` | Bearer | `{ faction: string \| null }` → `MeInfo`; 429 if changed < 1 h ago |
| `POST /api/report` | Bearer | `ReportRequest` → `{ ok: true }`; area ≤ `MAX_REPORT_SIZE`; max 10 open reports per wallet |
| `GET /api/seasons` | – | `SeasonArchive[]`, newest first |
| `GET /api/seasons/:id/image.png` | – | final image (1 px per cell; the client scales it with `image-rendering: pixelated`) |
| `GET /api/seasons/:id/timelapse.bin` | – | `shared/src/timelapse.ts` format |
| `POST /api/dev/balance` | Bearer, **mock mode only** (404 otherwise) | `{ balance: number }` → `MeInfo` |
| `GET /api/admin/reports` | admin | `Report[]` (open first) |
| `POST /api/admin/reports/:id/resolve` | admin | `{ ok: true }` |
| `POST /api/admin/wipe` | admin | `{ x, y, w, h }` → cells become `EMPTY`, owner 0; broadcast as `px` |
| `POST /api/admin/ban` | admin | `{ wallet, wipe?: boolean }`; `wipe` erases every cell it owns |
| `POST /api/admin/unban` | admin | `{ wallet }` |
| `POST /api/admin/season/end` | admin | end the live season now |
| `POST /api/admin/season/start` | admin | skip the break and start the next season now |
| `POST /api/admin/resize` | admin | `{ width, height }` grow only, ≤ `MAX_CANVAS_SIZE`, keeps content top-left; broadcast `reload` |

Session token: `base64url(JSON{ w: wallet, exp }) + "." + base64url(HMAC-SHA256)`,
sent as `Authorization: Bearer <token>` (REST) or `{t:'auth'}` (WS). Admin token
compared in constant time. REST rate limit (`@fastify/rate-limit`): 120 req/min per IP
globally, 10/min on `/api/auth/*`.

In `live` mode, balances come from JSON-RPC
`getTokenAccountsByOwner(wallet, { mint }, { encoding: 'jsonParsed' })`, summing
`account.data.parsed.info.tokenAmount.uiAmountString` (works for SPL Token and
Token-2022 mints). Plain `fetch`, 5 s timeout, no web3.js.

### WebSocket `/ws`

JSON text frames, types `ClientMsg` / `ServerMsg`. On connect the server sends
`hello`. Spectators receive everything except `ack`/`me`. Pixel changes are
batched into one `px` frame every ~50 ms. `lb` every 5 s when changed, `online`
when the count changes (throttled to 1/s). Ping/pong keeps proxies happy.

## Web

Vite multi-page app: `index.html` (game), `hall.html` (Hall of Fame),
`admin.html` (moderation). Dev server on 5173 proxies `/api` and `/ws` to
`localhost:8787`. Production: the server serves `web/dist`, with `/hall` →
`hall.html` and `/admin` → `admin.html`.

### Canvas sync (no lost pixels)

1. Open the WebSocket and buffer `px` frames.
2. `GET /api/config`, then `GET /api/canvas` (note `X-Canvas-Seq`).
3. Apply buffered and later `px` updates whose seq is greater than `X-Canvas-Seq`.
4. On `reload` or reconnect (exponential backoff), redo 1–3.

### Game screen (`index.html`), mobile-first

- Full-screen canvas: pan (drag / one finger), zoom (wheel / pinch, around the
  pointer, 1×–40×), crisp pixels (offscreen canvas of `w×h`, `imageSmoothingEnabled = false`).
  Reticle on the hovered cell; grid lines when zoomed ≥ 12×.
- Top bar: $PIXEL logo, season "Saison N · <thème>" with a countdown to the end
  (or to the next season when frozen), "CHAOS ×2" badge when active, online count,
  "Acheter $PIXEL" button (`token.buyUrl`), wallet button.
- Bottom bar: 32-colour palette, the selected colour, and the place button that
  turns into a countdown (`nextPlaceAt`) while on cooldown. Tap a cell to select
  it, then confirm (button or keyboard Enter / Space); on desktop a click places
  directly when ready.
- Optimistic placement: draw immediately, roll back if the ack is an error.
- Hover / selected cell tooltip: `(x, y)`, colour, `shortWallet` + faction, "il y a 3 min", or
  "Logo $PIXEL" for system pixels (debounced `GET /api/pixel`, small cache invalidated by `px`).
- Side panel (drawer on mobile): my stats (balance, tier, cooldown, placed, owned),
  tier table ("Garde 1 M $PIXEL → 1 pixel / 5 s"), faction picker (suggestions =
  `factions` + current leaderboard factions), leaderboard (factions + players).
- Report: "Signaler" on the selected cell opens a small form (zone around the
  cell, reason) → `POST /api/report`.
- Not holding enough: clear message "Achète au moins 10 000 $PIXEL pour jouer" + buy button.
- Frozen season: canvas read-only, banner "Saison terminée — prochaine saison dans …" + link to the Hall of Fame.
- Mock mode banner "Mode test : soldes fictifs" with an input to set your fake balance (`/api/dev/balance`).
- Errors from acks shown as short French toasts.

### Wallet connect

Wallet Standard (`@wallet-standard/app` `getWallets()`): list wallets that
support `standard:connect` and `solana:signMessage` (Phantom, Solflare, Backpack,
… appear automatically, including late registrations). Flow: connect → `POST /api/auth/nonce`
→ `signMessage(utf8(message))` → `POST /api/auth/verify` (signature base58) →
store `{ wallet, token, expiresAt }` in localStorage → `{t:'auth'}` on the socket.
Restore the session on reload if not expired. Disconnect clears it.
On mobile without an injected wallet, show deep links that open the site inside
the wallet browser: `https://phantom.app/ul/browse/<encoded url>?ref=<encoded origin>`
and `https://solflare.com/ul/v1/browse/<encoded url>?ref=<encoded origin>`.
In mock mode, add "Dev wallet (test)": a tweetnacl keypair kept in localStorage
that signs the same message — the server verifies it like a real wallet.

### Hall of Fame (`hall.html`)

Grid of past seasons (newest first): final image, number, theme, dates, pixels
placed, players, top 3 factions and players. Opening a season shows the image
large and a timelapse player (play/pause, speed, scrubber) that replays
`timelapse.bin` onto a canvas, plus a "Télécharger l'image" link.

### Admin (`admin.html`)

Asks for the admin token (kept in sessionStorage). Lists open reports with a
zoomed preview of the reported area taken from `/api/canvas`; actions: wipe the
area, resolve, ban the wallet (with or without wiping its pixels). Also: wipe a
custom rectangle, ban/unban by wallet, end the season, start the next season, resize.

## Quality bar

- `npm run typecheck` and `npm test` pass at the root.
- Server tests (vitest) cover: tiers/cooldowns, login signature verification
  (real tweetnacl keypair), session tokens (tamper/expiry), placement rules,
  season lifecycle with a fake clock (chaos, freeze, logo, archive, reset),
  timelapse moderation scrubbing, persistence round-trip, and one WebSocket
  integration test (sign in, place, receive `px`).
- No secrets in the repo. Validate every input. Never trust the client for cooldowns.
