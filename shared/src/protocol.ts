/**
 * Contract between server/ and web/. See docs/ARCHITECTURE.md for the full
 * description of every endpoint and message.
 */
import type { Tier } from './tiers';

export const PROTOCOL_VERSION = 1;

/** Largest canvas the server will ever create (memory + payload bound). */
export const MAX_CANVAS_SIZE = 1000;
/** Largest area a single report may cover. */
export const MAX_REPORT_SIZE = 64;

export interface ChaosInfo {
  /** True during the last hours of a live season. */
  active: boolean;
  /** ms epoch when chaos starts (endsAt - chaosHours). */
  startsAt: number;
  /** Cooldown multiplier while active (0.5 = twice as fast). */
  factor: number;
}

export interface SeasonInfo {
  /** "s1", "s2", … */
  id: string;
  number: number;
  theme: string;
  /** ms epoch */
  startedAt: number;
  /** ms epoch when the canvas freezes */
  endsAt: number;
  /** live = painting allowed; frozen = season over, final image on show until nextSeasonAt */
  status: 'live' | 'frozen';
  /** ms epoch when the next season starts (only when frozen) */
  nextSeasonAt: number | null;
  chaos: ChaosInfo;
}

/** GET /api/config */
export interface PublicConfig {
  protocolVersion: number;
  /** mock = fake balances for testing, live = balances read on Solana mainnet */
  mode: 'mock' | 'live';
  token: {
    symbol: string;
    /** SPL mint address, null until the coin is launched */
    mint: string | null;
    /** Where the "Acheter" button points (pump.fun page), null if unknown */
    buyUrl: string | null;
  };
  palette: string[];
  emptyColor: string;
  width: number;
  height: number;
  tiers: Tier[];
  /** Suggested faction names (may be empty) */
  factions: string[];
  season: SeasonInfo;
  /** ms epoch of the server clock, so the client can correct countdowns */
  serverTime: number;
}

/** GET /api/pixel?x=&y= */
export interface PixelInfo {
  x: number;
  y: number;
  /** palette index or EMPTY */
  color: number;
  /** null for empty pixels and for the $PIXEL logo stamped at season end */
  wallet: string | null;
  faction: string | null;
  /** ms epoch, null if never painted this season */
  placedAt: number | null;
  /** true for pixels of the $PIXEL logo */
  system: boolean;
}

/** GET /api/me (and the `me` WS message) */
export interface MeInfo {
  wallet: string;
  /** $PIXEL held (UI amount); fake in mock mode */
  balance: number;
  /** null = holds too little, must buy to paint */
  tier: Tier | null;
  /** effective cooldown with chaos applied, null without tier */
  cooldownMs: number | null;
  /** ms epoch when the next pixel can be placed; 0 = ready now */
  nextPlaceAt: number;
  faction: string | null;
  /** ms epoch before which the faction cannot change again; 0 = can change */
  factionLockedUntil: number;
  /** pixels placed this season */
  placed: number;
  /** pixels currently on the canvas owned by this wallet */
  owned: number;
  banned: boolean;
}

export interface Leaderboard {
  /** Sorted desc by pixels currently owned on the canvas (territory). Top 20. */
  factions: { faction: string; pixels: number; players: number }[];
  /** Sorted desc by pixels currently owned. Top 20. */
  players: { wallet: string; faction: string | null; pixels: number; placed: number }[];
  totalPlacements: number;
  uniquePlayers: number;
  updatedAt: number;
}

/** GET /api/seasons -> SeasonArchive[] (newest first) */
export interface SeasonArchive {
  id: string;
  number: number;
  theme: string;
  startedAt: number;
  endedAt: number;
  width: number;
  height: number;
  totalPlacements: number;
  uniquePlayers: number;
  topFactions: Leaderboard['factions'];
  topPlayers: Leaderboard['players'];
  /** /api/seasons/:id/image.png — final canvas with the $PIXEL logo */
  imageUrl: string;
  /** /api/seasons/:id/timelapse.bin — see timelapse.ts */
  timelapseUrl: string;
}

/** Admin: GET /api/admin/reports */
export interface Report {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  reason: string;
  /** reporter wallet */
  wallet: string;
  createdAt: number;
  status: 'open' | 'resolved';
}

/** Admin: GET /api/admin/owners?x=&y=&w=&h= — who painted the pixels of an area (most pixels first; empty cells and the logo are left out). */
export interface AreaOwners {
  owners: { wallet: string; faction: string | null; pixels: number }[];
}

export type PlaceErrorCode =
  | 'unauthenticated'
  | 'cooldown'
  | 'not_holder'
  | 'banned'
  | 'frozen'
  | 'out_of_bounds'
  | 'bad_color'
  | 'rate_limited'
  | 'rpc_unavailable'
  | 'internal';

/* ---------------- WebSocket /ws (JSON text frames) ---------------- */

export type ClientMsg =
  /** Attach a session to this socket (spectators never send it). */
  | { t: 'auth'; token: string }
  /** Place one pixel. `id` is echoed back in the ack. */
  | { t: 'place'; x: number; y: number; c: number; id?: number }
  | { t: 'ping' };

export type ServerMsg =
  /** First message after connect. */
  | { t: 'hello'; protocolVersion: number; online: number; seq: number; season: SeasonInfo }
  /** Reply to `auth`. */
  | { t: 'authed'; ok: true; me: MeInfo }
  | { t: 'authed'; ok: false; code: 'unauthenticated' }
  /**
   * Batched pixel updates (every ~50 ms). `d` is flat [x, y, c, x, y, c, …];
   * the i-th pixel has sequence number s + i. c may be EMPTY (moderation wipe).
   */
  | { t: 'px'; s: number; d: number[] }
  /** Reply to `place`. */
  | { t: 'ack'; id?: number; ok: true; nextPlaceAt: number; me: MeInfo }
  | { t: 'ack'; id?: number; ok: false; code: PlaceErrorCode; message: string; nextPlaceAt?: number }
  /** Pushed when the player's balance/tier/cooldown changes. */
  | { t: 'me'; me: MeInfo }
  /** Pushed every ~5 s when it changed. */
  | { t: 'lb'; lb: Leaderboard }
  /** Season state changed (chaos started, frozen, new season). */
  | { t: 'season'; season: SeasonInfo }
  /** Canvas replaced (new season, resize): refetch /api/config and /api/canvas. */
  | { t: 'reload'; reason: 'season' | 'resize' }
  | { t: 'online'; n: number }
  | { t: 'pong' };

/* ---------------- REST bodies ---------------- */

/** POST /api/auth/nonce */
export interface NonceRequest { wallet: string }
export interface NonceResponse { nonce: string; message: string; expiresAt: number }

/** POST /api/auth/verify — signature is base58 of the 64-byte ed25519 signature of `message` (UTF-8). */
export interface VerifyRequest { wallet: string; nonce: string; signature: string }
export interface VerifyResponse { token: string; expiresAt: number; me: MeInfo }

/** POST /api/report */
export interface ReportRequest { x: number; y: number; w: number; h: number; reason: string }

/** Every non-2xx JSON response. */
export interface ApiError { error: string; message: string }
