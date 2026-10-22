import type { SeasonInfo } from '@pixel/shared';
import { buildArchive, type ArchiveStore } from './archive';
import type { ServerConfig } from './config';
import type { ServerEvents } from './events';
import type { Bitmap, Game } from './game';
import { logoOrigin } from './logo';

export interface SeasonState {
  number: number;
  theme: string;
  /** ms epoch */
  startedAt: number;
  /** ms epoch when the canvas freezes (moved earlier if an admin ends the season) */
  endsAt: number;
  status: 'live' | 'frozen';
  /** ms epoch, only when frozen */
  nextSeasonAt: number | null;
}

type SeasonConfig = Pick<ServerConfig, 'seasonMs' | 'chaosMs' | 'chaosFactor' | 'themes'>;

export const seasonId = (number: number): string => `s${number}`;

/** A live season starting now; themes cycle with the season number. */
export function newSeason(number: number, now: number, cfg: SeasonConfig): SeasonState {
  return {
    number,
    theme: cfg.themes[(number - 1) % cfg.themes.length]!,
    startedAt: now,
    endsAt: now + cfg.seasonMs,
    status: 'live',
    nextSeasonAt: null,
  };
}

export function isChaosActive(s: SeasonState, now: number, cfg: SeasonConfig): boolean {
  return s.status === 'live' && cfg.chaosMs > 0 && now >= s.endsAt - cfg.chaosMs;
}

export function toSeasonInfo(s: SeasonState, now: number, cfg: SeasonConfig): SeasonInfo {
  return {
    id: seasonId(s.number),
    number: s.number,
    theme: s.theme,
    startedAt: s.startedAt,
    endsAt: s.endsAt,
    status: s.status,
    nextSeasonAt: s.nextSeasonAt,
    chaos: { active: isChaosActive(s, now, cfg), startsAt: s.endsAt - cfg.chaosMs, factor: cfg.chaosFactor },
  };
}

export interface SeasonDeps {
  config: ServerConfig;
  now: () => number;
  game: Game;
  archives: ArchiveStore;
  logo: Bitmap;
  events: ServerEvents;
}

/** Drives live → chaos → frozen (logo + archive) → break → next season, from an injectable clock. */
export class SeasonManager {
  private chaosAnnounced: boolean;

  constructor(public state: SeasonState, private readonly deps: SeasonDeps) {
    this.chaosAnnounced = isChaosActive(state, deps.now(), deps.config);
  }

  get id(): string {
    return seasonId(this.state.number);
  }

  info(): SeasonInfo {
    return toSeasonInfo(this.state, this.deps.now(), this.deps.config);
  }

  isLive(): boolean {
    return this.state.status === 'live';
  }

  chaosActive(): boolean {
    return isChaosActive(this.state, this.deps.now(), this.deps.config);
  }

  /** Called every second; performs whichever transition is due. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    const s = this.state;
    if (s.status === 'live') {
      if (now >= s.endsAt) return this.end();
      if (!this.chaosAnnounced && this.chaosActive()) this.announceChaos();
    } else if (s.nextSeasonAt !== null && now >= s.nextSeasonAt) {
      this.startNext();
    }
  }

  /** Freezes the canvas, stamps the logo and archives the season. No-op if already frozen. */
  async end(): Promise<void> {
    if (!this.isLive()) return;
    const now = this.deps.now();
    this.state = {
      ...this.state,
      status: 'frozen',
      endsAt: Math.min(this.state.endsAt, now),
      nextSeasonAt: now + this.deps.config.breakMs,
    };
    this.stampLogo(now);
    this.deps.game.dirty = true;
    const archived = this.archive();
    this.deps.events.emit('season', this.info());
    await archived;
  }

  /** Starts the next season on an empty canvas. No-op while a season is live. */
  startNext(): void {
    if (this.isLive()) return;
    const { config, game, events } = this.deps;
    const now = this.deps.now();
    this.state = newSeason(this.state.number + 1, now, config);
    game.reset(config.canvasWidth, config.canvasHeight, now);
    this.chaosAnnounced = this.chaosActive();
    events.emit('season', this.info());
    events.emit('reload', 'season');
    events.emit('allMe');
  }

  /**
   * Renders the archive of the frozen season from the canvas as it is now
   * (at freeze time, after moderation of the final image, or on boot if a crash lost it).
   */
  archive(): Promise<void> {
    const s = this.state;
    const season = { id: this.id, number: s.number, theme: s.theme, startedAt: s.startedAt, endedAt: s.endsAt };
    return this.deps.archives.write(buildArchive(this.deps.game, season, this.deps.now()));
  }

  private announceChaos(): void {
    this.chaosAnnounced = true;
    this.deps.events.emit('season', this.info());
    this.deps.events.emit('allMe');
  }

  private stampLogo(now: number): void {
    const { game, logo, config } = this.deps;
    const origin = logoOrigin(logo, game.width, game.height, config.logoPosition);
    game.stamp(logo, origin.x, origin.y, now);
  }
}
