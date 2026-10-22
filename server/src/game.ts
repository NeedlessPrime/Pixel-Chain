import {
  EMPTY, isValidColor, tierForBalance,
  type Leaderboard, type PixelInfo, type PlaceErrorCode, type Tier,
} from '@pixel/shared';
import { PlacementLog } from './log';

/** Values of the `owners` array. */
export const NO_OWNER = 0;
export const SYSTEM_OWNER = 1;
const FIRST_PLAYER_ID = 2;

export const FACTION_CHANGE_INTERVAL_MS = 3_600_000;
const LEADERBOARD_SIZE = 20;

export interface Player {
  id: number;
  wallet: string;
  faction: string | null;
  factionChangedAt: number;
  /** Pixels placed this season. */
  placed: number;
  /** Pixels currently on the canvas (derived from `owners`, never persisted). */
  owned: number;
  /** ms epoch; 0 = ready. */
  nextPlaceAt: number;
}

export interface PlaceContext {
  now: number;
  live: boolean;
  /** Balance to judge the tier with; null when it could not be read (RPC down, nothing recent cached). */
  balance: number | null;
  tiers: readonly Tier[];
  /** Cooldown for a tier right now (chaos applied). */
  cooldownMs: (tier: Tier) => number;
}

export interface PlaceRejection {
  ok: false;
  code: PlaceErrorCode;
  nextPlaceAt?: number;
}

export type PlaceOutcome = { ok: true; player: Player } | PlaceRejection;

/** Palette indices (or EMPTY = transparent) of an image stamped as system pixels. */
export interface Bitmap {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Pixel changes not broadcast yet: `d` is flat [x, y, c, …], the i-th pixel has seq `s + i`. */
export interface PixelBatch {
  s: number;
  d: number[];
}

export interface GameSnapshot {
  width: number;
  height: number;
  startedAt: number;
  seq: number;
  totalPlacements: number;
  nextPlayerId: number;
  players: Omit<Player, 'owned'>[];
  banned: string[];
}

function reject(code: PlaceErrorCode, nextPlaceAt?: number): PlaceRejection {
  return nextPlaceAt === undefined ? { ok: false, code } : { ok: false, code, nextPlaceAt };
}

/** The canvas of the current season, its players and its change log. Synchronous and O(1) per pixel. */
export class Game {
  width: number;
  height: number;
  colors: Uint8Array;
  owners: Uint32Array;
  times: Uint32Array;
  /** ms epoch of the season start; `times` are seconds since then. */
  startedAt: number;
  /** Global pixel sequence number, never reset. */
  seq = 0;
  totalPlacements = 0;
  log = new PlacementLog();
  /** Wallets that may not paint (kept across seasons). */
  readonly banned = new Set<string>();
  /** Set on every change, cleared by persistence. */
  dirty = false;
  /** Bumped on every change that can affect the leaderboard. */
  version = 0;

  private readonly players = new Map<number, Player>();
  private readonly byWallet = new Map<string, Player>();
  private nextPlayerId = FIRST_PLAYER_ID;
  private pending: number[] = [];
  private pendingSeq = 0;
  private readonly ownedChanged = new Set<string>();
  private lbCache: { version: number; lb: Leaderboard } | null = null;

  constructor(width: number, height: number, startedAt: number) {
    this.width = width;
    this.height = height;
    this.startedAt = startedAt;
    this.colors = new Uint8Array(width * height).fill(EMPTY);
    this.owners = new Uint32Array(width * height);
    this.times = new Uint32Array(width * height);
  }

  static restore(snap: GameSnapshot, colors: Uint8Array, owners: Uint32Array, times: Uint32Array, log: Uint8Array): Game {
    const cells = snap.width * snap.height;
    if (colors.length !== cells || owners.length !== cells || times.length !== cells) {
      throw new Error(`canvas files do not match the saved size ${snap.width}x${snap.height}`);
    }
    const game = new Game(snap.width, snap.height, snap.startedAt);
    Object.assign(game, { colors, owners, times, seq: snap.seq, totalPlacements: snap.totalPlacements });
    game.nextPlayerId = snap.nextPlayerId;
    game.log = new PlacementLog(log);
    for (const p of snap.players) game.addPlayer({ ...p, owned: 0 });
    for (const wallet of snap.banned) game.banned.add(wallet);
    for (const owner of owners) {
      if (owner >= FIRST_PLAYER_ID) game.players.get(owner)!.owned++;
    }
    return game;
  }

  snapshot(): GameSnapshot {
    return {
      width: this.width,
      height: this.height,
      startedAt: this.startedAt,
      seq: this.seq,
      totalPlacements: this.totalPlacements,
      nextPlayerId: this.nextPlayerId,
      players: [...this.players.values()].map(({ owned: _owned, ...rest }) => rest),
      banned: [...this.banned],
    };
  }

  inBounds(x: unknown, y: unknown): x is number {
    return Number.isInteger(x) && Number.isInteger(y) &&
      (x as number) >= 0 && (y as number) >= 0 && (x as number) < this.width && (y as number) < this.height;
  }

  player(wallet: string): Player | undefined {
    return this.byWallet.get(wallet);
  }

  ensurePlayer(wallet: string): Player {
    return this.byWallet.get(wallet) ?? this.addPlayer({
      id: this.nextPlayerId++, wallet, faction: null, factionChangedAt: 0, placed: 0, owned: 0, nextPlaceAt: 0,
    });
  }

  /** The checks that need no balance, in the documented order. */
  precheck(wallet: string | null, x: unknown, y: unknown, c: unknown, live: boolean): PlaceRejection | null {
    if (!wallet) return reject('unauthenticated');
    if (!live) return reject('frozen');
    if (!this.inBounds(x, y)) return reject('out_of_bounds');
    if (!isValidColor(c)) return reject('bad_color');
    if (this.banned.has(wallet)) return reject('banned');
    return null;
  }

  place(wallet: string | null, x: number, y: number, c: number, ctx: PlaceContext): PlaceOutcome {
    const rejected = this.precheck(wallet, x, y, c, ctx.live);
    if (rejected) return rejected;
    if (ctx.balance === null) return reject('rpc_unavailable');
    const tier = tierForBalance(ctx.balance, ctx.tiers);
    if (!tier) return reject('not_holder');
    const player = this.ensurePlayer(wallet!);
    if (ctx.now < player.nextPlaceAt) return reject('cooldown', player.nextPlaceAt);

    this.writeCell(x, y, c, player.id, ctx.now);
    player.placed++;
    this.totalPlacements++;
    player.nextPlaceAt = ctx.now + ctx.cooldownMs(tier);
    return { ok: true, player };
  }

  /** Erases a rectangle (clipped to the canvas). Returns the number of cells erased. */
  wipeRect(x: number, y: number, w: number, h: number, now: number): number {
    let erased = 0;
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        if (this.erase(xx, yy, now)) erased++;
      }
    }
    return erased;
  }

  /** Erases every cell currently owned by a wallet. */
  wipeOwner(wallet: string, now: number): number {
    const player = this.byWallet.get(wallet);
    if (!player || player.owned === 0) return 0;
    let erased = 0;
    for (let i = 0; i < this.owners.length; i++) {
      if (this.owners[i] === player.id && this.erase(i % this.width, Math.floor(i / this.width), now)) erased++;
    }
    return erased;
  }

  /** Draws a bitmap as system pixels with its top-left corner at (x0, y0), clipped to the canvas. */
  stamp(image: Bitmap, x0: number, y0: number, now: number): number {
    let written = 0;
    for (let ly = 0; ly < image.height; ly++) {
      for (let lx = 0; lx < image.width; lx++) {
        const c = image.pixels[ly * image.width + lx]!;
        if (c === EMPTY || !this.inBounds(x0 + lx, y0 + ly)) continue;
        this.writeCell(x0 + lx, y0 + ly, c, SYSTEM_OWNER, now);
        written++;
      }
    }
    return written;
  }

  /** Grows the canvas, keeping the content in the top-left corner. */
  resize(width: number, height: number): void {
    if (width < this.width || height < this.height) throw new Error('the canvas can only grow');
    const colors = new Uint8Array(width * height).fill(EMPTY);
    const owners = new Uint32Array(width * height);
    const times = new Uint32Array(width * height);
    for (let y = 0; y < this.height; y++) {
      const from = y * this.width;
      colors.set(this.colors.subarray(from, from + this.width), y * width);
      owners.set(this.owners.subarray(from, from + this.width), y * width);
      times.set(this.times.subarray(from, from + this.width), y * width);
    }
    Object.assign(this, { width, height, colors, owners, times });
    this.touch();
  }

  /** Empty canvas for a new season: per-season stats and cooldowns reset, factions and bans kept. */
  reset(width: number, height: number, startedAt: number): void {
    Object.assign(this, {
      width, height, startedAt,
      colors: new Uint8Array(width * height).fill(EMPTY),
      owners: new Uint32Array(width * height),
      times: new Uint32Array(width * height),
      log: new PlacementLog(),
      totalPlacements: 0,
    });
    for (const p of this.players.values()) Object.assign(p, { placed: 0, owned: 0, nextPlaceAt: 0 });
    this.ownedChanged.clear();
    this.touch();
  }

  /** ms epoch before which this player may not change faction again; 0 = free to change. */
  factionLockedUntil(player: Player | undefined, now: number): number {
    if (!player?.factionChangedAt) return 0;
    const until = player.factionChangedAt + FACTION_CHANGE_INTERVAL_MS;
    return now < until ? until : 0;
  }

  setFaction(wallet: string, faction: string | null, now: number): { ok: true } | { ok: false; lockedUntil: number } {
    const player = this.ensurePlayer(wallet);
    if (player.faction === faction) return { ok: true };
    const lockedUntil = this.factionLockedUntil(player, now);
    if (lockedUntil) return { ok: false, lockedUntil };
    player.faction = faction;
    player.factionChangedAt = now;
    this.touch();
    return { ok: true };
  }

  ban(wallet: string): void {
    this.banned.add(wallet);
    this.touch();
  }

  unban(wallet: string): boolean {
    const removed = this.banned.delete(wallet);
    this.touch();
    return removed;
  }

  pixelInfo(x: number, y: number): PixelInfo {
    const i = y * this.width + x;
    const owner = this.owners[i]!;
    const player = this.players.get(owner);
    return {
      x,
      y,
      color: this.colors[i]!,
      wallet: player?.wallet ?? null,
      faction: player?.faction ?? null,
      placedAt: owner === NO_OWNER ? null : this.startedAt + this.times[i]! * 1000,
      system: owner === SYSTEM_OWNER,
    };
  }

  /** Territory leaderboard, recomputed only when something changed. Banned wallets are hidden. */
  leaderboard(now: number): Leaderboard {
    if (this.lbCache?.version === this.version) return this.lbCache.lb;
    const factions = new Map<string, { faction: string; pixels: number; players: number }>();
    const active: Player[] = [];
    for (const p of this.players.values()) {
      if ((p.placed === 0 && p.owned === 0) || this.banned.has(p.wallet)) continue;
      active.push(p);
      if (!p.faction || p.owned === 0) continue;
      const f = factions.get(p.faction) ?? { faction: p.faction, pixels: 0, players: 0 };
      f.pixels += p.owned;
      f.players++;
      factions.set(p.faction, f);
    }
    active.sort((a, b) => b.owned - a.owned || b.placed - a.placed);
    const lb: Leaderboard = {
      factions: [...factions.values()].sort((a, b) => b.pixels - a.pixels || b.players - a.players).slice(0, LEADERBOARD_SIZE),
      players: active.slice(0, LEADERBOARD_SIZE).map((p) => ({ wallet: p.wallet, faction: p.faction, pixels: p.owned, placed: p.placed })),
      totalPlacements: this.totalPlacements,
      uniquePlayers: active.filter((p) => p.placed > 0).length,
      updatedAt: now,
    };
    this.lbCache = { version: this.version, lb };
    return lb;
  }

  /** Pixel changes since the last call, or null if none. */
  drainPixels(): PixelBatch | null {
    if (this.pending.length === 0) return null;
    const batch = { s: this.pendingSeq, d: this.pending };
    this.pending = [];
    return batch;
  }

  /** Wallets whose owned-pixel count changed since the last call. */
  drainOwnedChanged(): string[] {
    const wallets = [...this.ownedChanged];
    this.ownedChanged.clear();
    return wallets;
  }

  private addPlayer(player: Player): Player {
    this.players.set(player.id, player);
    this.byWallet.set(player.wallet, player);
    return player;
  }

  private erase(x: number, y: number, now: number): boolean {
    const i = y * this.width + x;
    if (this.colors[i] === EMPTY && this.owners[i] === NO_OWNER) return false;
    this.writeCell(x, y, EMPTY, NO_OWNER, now);
    return true;
  }

  /** The only place a cell changes: owner counts, seq, log and broadcast queue stay in sync. */
  private writeCell(x: number, y: number, c: number, owner: number, now: number): void {
    const i = y * this.width + x;
    const previous = this.owners[i]!;
    if (previous !== owner) {
      this.adjustOwned(previous, -1);
      this.adjustOwned(owner, 1);
    }
    this.colors[i] = c;
    this.owners[i] = owner;
    this.times[i] = owner === NO_OWNER ? 0 : Math.max(0, Math.floor((now - this.startedAt) / 1000));
    this.seq++;
    this.log.append(x, y, c);
    if (this.pending.length === 0) this.pendingSeq = this.seq;
    this.pending.push(x, y, c);
    this.touch();
  }

  private adjustOwned(owner: number, delta: number): void {
    const player = this.players.get(owner);
    if (!player) return;
    player.owned += delta;
    this.ownedChanged.add(player.wallet);
  }

  private touch(): void {
    this.dirty = true;
    this.version++;
  }
}
