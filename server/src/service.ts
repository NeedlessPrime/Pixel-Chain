import {
  EMPTY_COLOR, PALETTE, PROTOCOL_VERSION, effectiveCooldownMs, tierForBalance,
  type Leaderboard, type MeInfo, type NonceResponse, type PixelInfo, type PlaceErrorCode,
  type PublicConfig, type Report, type SeasonArchive, type Tier, type VerifyResponse,
} from '@pixel/shared';
import type { ArchiveFile, ArchiveStore } from './archive';
import {
  createSessionToken, verifyLoginSignature, verifySessionToken, type NonceStore, type Session,
} from './auth';
import type { BalanceCache, MockBalances } from './balances';
import type { ServerConfig } from './config';
import type { ServerEvents } from './events';
import type { Game, PlaceRejection } from './game';
import { placeErrorMessage } from './messages';
import type { NewReport, ReportStore } from './reports';
import type { SeasonManager } from './season';

export type PlaceResult =
  | { ok: true; nextPlaceAt: number; me: MeInfo }
  | { ok: false; code: PlaceErrorCode; message: string; nextPlaceAt?: number };

export type LoginResult = { ok: true; res: VerifyResponse } | { ok: false; code: 'invalid_nonce' | 'bad_signature' };

export interface ServiceDeps {
  config: ServerConfig;
  now: () => number;
  game: Game;
  season: SeasonManager;
  balances: BalanceCache;
  /** Only in mock mode. */
  mock: MockBalances | null;
  reports: ReportStore;
  archives: ArchiveStore;
  nonces: NonceStore;
  events: ServerEvents;
  sessionSecret: string;
}

/**
 * Everything players and admins can do, independent of the transport. Both the
 * REST routes and the WebSocket hub call into this; it never trusts its inputs.
 * `game.dirty` is the single "something to persist" flag.
 */
export class PixelService {
  constructor(private readonly d: ServiceDeps) {}

  get game(): Game {
    return this.d.game;
  }

  get season(): SeasonManager {
    return this.d.season;
  }

  get mockMode(): boolean {
    return this.d.mock !== null;
  }

  /* ---------------- public reads ---------------- */

  publicConfig(): PublicConfig {
    const { config, game } = this.d;
    return {
      protocolVersion: PROTOCOL_VERSION,
      mode: config.mode,
      token: { ...config.token },
      palette: [...PALETTE],
      emptyColor: EMPTY_COLOR,
      width: game.width,
      height: game.height,
      tiers: config.tiers,
      factions: config.factions,
      season: this.d.season.info(),
      serverTime: this.d.now(),
    };
  }

  /** A copy of the canvas with the seq of the last change it includes. */
  canvas(): { width: number; height: number; seq: number; bytes: Buffer } {
    const { game } = this.d;
    return { width: game.width, height: game.height, seq: game.seq, bytes: Buffer.from(game.colors) };
  }

  pixelInfo(x: number, y: number): PixelInfo | null {
    return this.d.game.inBounds(x, y) ? this.d.game.pixelInfo(x, y) : null;
  }

  leaderboard(): Leaderboard {
    return this.d.game.leaderboard(this.d.now());
  }

  /** Archives, newest first; wallets banned since an archive was rendered are left out of its top players. */
  seasons(): SeasonArchive[] {
    const { banned } = this.d.game;
    return this.d.archives.list().map((a) =>
      a.topPlayers.some((p) => banned.has(p.wallet)) ? { ...a, topPlayers: a.topPlayers.filter((p) => !banned.has(p.wallet)) } : a,
    );
  }

  archiveFile(seasonId: string, file: ArchiveFile): string | null {
    return this.d.archives.filePath(seasonId, file);
  }

  /* ---------------- sessions ---------------- */

  issueNonce(wallet: string, domain: string): NonceResponse {
    return this.d.nonces.issue(wallet, domain);
  }

  async login(wallet: string, nonce: string, signature: string): Promise<LoginResult> {
    const message = this.d.nonces.consume(wallet, nonce);
    if (!message) return { ok: false, code: 'invalid_nonce' };
    if (!verifyLoginSignature(message, wallet, signature)) return { ok: false, code: 'bad_signature' };
    const { token, expiresAt } = createSessionToken(wallet, this.d.sessionSecret, this.d.now());
    return { ok: true, res: { token, expiresAt, me: await this.me(wallet) } };
  }

  session(token: unknown): Session | null {
    return verifySessionToken(token, this.d.sessionSecret, this.d.now());
  }

  /* ---------------- players ---------------- */

  /** MeInfo from the last known balance, without I/O (for pushes). */
  meCached(wallet: string): MeInfo {
    return this.buildMe(wallet, this.d.balances.peek(wallet)?.balance ?? 0);
  }

  /** MeInfo with the balance refreshed per the cache rules; the last known value if the RPC is down. */
  async me(wallet: string, forceRefresh = false): Promise<MeInfo> {
    try {
      return this.buildMe(wallet, await this.d.balances.get(wallet, forceRefresh));
    } catch {
      return this.meCached(wallet);
    }
  }

  async place(wallet: string | null, x: number, y: number, c: number): Promise<PlaceResult> {
    const { game, season, balances, config } = this.d;
    // Cheap checks first, so invalid requests never trigger a balance read.
    const early = game.precheck(wallet, x, y, c, season.isLive());
    if (early) return this.rejection(early);

    let balance: number | null;
    try {
      balance = await balances.get(wallet!);
    } catch {
      balance = null;
    }
    // Synchronous from here on: the checks are re-run against the state as it is after the await.
    const outcome = game.place(wallet, x, y, c, {
      now: this.d.now(),
      live: season.isLive(),
      balance,
      tiers: config.tiers,
      cooldownMs: (tier) => this.cooldownMs(tier),
    });
    if (!outcome.ok) return this.rejection(outcome);
    return { ok: true, nextPlaceAt: outcome.player.nextPlaceAt, me: this.buildMe(wallet!, balance!) };
  }

  /** A failed placement decided outside the game (e.g. the transport's rate limit). */
  placeRejection(code: PlaceErrorCode): PlaceResult {
    return this.rejection({ ok: false, code });
  }

  setFaction(wallet: string, faction: string | null): { ok: true } | { ok: false; lockedUntil: number } {
    const result = this.d.game.setFaction(wallet, faction, this.d.now());
    if (result.ok) this.d.events.emit('me', wallet);
    return result;
  }

  report(wallet: string, area: NewReport): Report | null {
    const report = this.d.reports.add(wallet, area, this.d.now());
    if (report) this.d.game.dirty = true;
    return report;
  }

  /** Mock mode only: returns false when balances are real. */
  setMockBalance(wallet: string, balance: number): boolean {
    if (!this.d.mock) return false;
    this.d.mock.set(wallet, balance);
    this.d.balances.set(wallet, balance);
    this.d.game.dirty = true;
    this.d.events.emit('me', wallet);
    return true;
  }

  /* ---------------- admin ---------------- */

  reports(): Report[] {
    return this.d.reports.list();
  }

  resolveReport(id: string): boolean {
    const ok = this.d.reports.resolve(id);
    if (ok) this.d.game.dirty = true;
    return ok;
  }

  async wipe(x: number, y: number, w: number, h: number): Promise<number> {
    const erased = this.d.game.wipeRect(x, y, w, h, this.d.now());
    if (erased) await this.afterModeration();
    return erased;
  }

  async ban(wallet: string, wipe: boolean): Promise<number> {
    this.d.game.ban(wallet);
    const erased = wipe ? this.d.game.wipeOwner(wallet, this.d.now()) : 0;
    this.d.events.emit('me', wallet);
    if (erased || this.inFrozenTopPlayers(wallet)) await this.afterModeration();
    return erased;
  }

  unban(wallet: string): void {
    this.d.game.unban(wallet);
    this.d.events.emit('me', wallet);
  }

  /** Grow-only; returns false for an invalid size. */
  resize(width: number, height: number): boolean {
    const { game } = this.d;
    if (width < game.width || height < game.height) return false;
    if (width === game.width && height === game.height) return true;
    game.resize(width, height);
    this.d.events.emit('reload', 'resize');
    return true;
  }

  /** Returns false if the season is not live. */
  async endSeason(): Promise<boolean> {
    if (!this.d.season.isLive()) return false;
    await this.d.season.end();
    return true;
  }

  /** Skips the break; returns false while a season is live. */
  startSeason(): boolean {
    if (this.d.season.isLive()) return false;
    this.d.season.startNext();
    return true;
  }

  /* ---------------- internals ---------------- */

  private cooldownMs(tier: Tier): number {
    return effectiveCooldownMs(tier, this.d.season.chaosActive(), this.d.config.chaosFactor);
  }

  private buildMe(wallet: string, balance: number): MeInfo {
    const { game, config } = this.d;
    const now = this.d.now();
    const player = game.player(wallet);
    const tier = tierForBalance(balance, config.tiers);
    return {
      wallet,
      balance,
      tier,
      cooldownMs: tier ? this.cooldownMs(tier) : null,
      nextPlaceAt: player && player.nextPlaceAt > now ? player.nextPlaceAt : 0,
      faction: player?.faction ?? null,
      factionLockedUntil: game.factionLockedUntil(player, now),
      placed: player?.placed ?? 0,
      owned: player?.owned ?? 0,
      banned: game.banned.has(wallet),
    };
  }

  private rejection(r: PlaceRejection): PlaceResult {
    const minBalance = Math.min(...this.d.config.tiers.map((t) => t.minBalance));
    const message = placeErrorMessage(r.code, {
      now: this.d.now(), nextPlaceAt: r.nextPlaceAt, minBalance, symbol: this.d.config.token.symbol,
    });
    return r.nextPlaceAt === undefined
      ? { ok: false, code: r.code, message }
      : { ok: false, code: r.code, message, nextPlaceAt: r.nextPlaceAt };
  }

  /** Whether the Hall of Fame entry of the frozen season lists this wallet among its top players. */
  private inFrozenTopPlayers(wallet: string): boolean {
    const { season, archives } = this.d;
    return !season.isLive() && !!archives.meta(season.id)?.topPlayers.some((p) => p.wallet === wallet);
  }

  /** A moderated final image must not stay in the Hall of Fame: re-render the archive. */
  private async afterModeration(): Promise<void> {
    if (!this.d.season.isLive()) await this.d.season.archive();
  }
}
