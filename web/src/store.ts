import type { Leaderboard, MeInfo, PublicConfig, SeasonInfo } from '@pixel/shared';
import type { Session } from './wallet';

export interface Cell {
  x: number;
  y: number;
}

export type Connection = 'connecting' | 'online' | 'offline';

export interface GameState {
  config: PublicConfig | null;
  season: SeasonInfo | null;
  session: Session | null;
  me: MeInfo | null;
  online: number;
  connection: Connection;
  /** True once the socket accepted our session token (placing needs it). */
  authed: boolean;
  leaderboard: Leaderboard | null;
  selected: Cell | null;
  color: number;
  /** A placement is waiting for its ack. */
  placing: boolean;
}

type Listener<T> = (state: T, prev: T) => void;

/** Minimal observable state: UI modules subscribe and re-render the bits they own. */
export class Store<T extends object> {
  private listeners = new Set<Listener<T>>();

  constructor(private state: T) {}

  get(): T {
    return this.state;
  }

  set(patch: Partial<T>): void {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const fn of this.listeners) fn(this.state, prev);
  }

  /** Calls `fn` now and on every change. */
  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    fn(this.state, this.state);
    return () => this.listeners.delete(fn);
  }
}

export function createGameStore(): Store<GameState> {
  return new Store<GameState>({
    config: null,
    season: null,
    session: null,
    me: null,
    online: 0,
    connection: 'connecting',
    authed: false,
    leaderboard: null,
    selected: null,
    color: 2, // the $PIXEL orange
    placing: false,
  });
}

/** Reasons the player cannot place right now, in priority order (null = ready). */
export type Blocker = 'loading' | 'frozen' | 'offline' | 'signed_out' | 'banned' | 'not_holder' | 'cooldown';

export function placeBlocker(s: GameState, now: number): Blocker | null {
  if (!s.config || !s.season) return 'loading';
  if (s.season.status !== 'live') return 'frozen';
  if (!s.session) return 'signed_out';
  if (s.connection !== 'online' || !s.authed || !s.me) return 'offline';
  if (s.me.banned) return 'banned';
  if (!s.me.tier) return 'not_holder';
  if (s.me.nextPlaceAt > now) return 'cooldown';
  return null;
}

/** Lowest balance that lets a wallet play. */
export function minHolding(config: PublicConfig): number {
  return Math.min(...config.tiers.map((t) => t.minBalance));
}

/** The configured buy link, only if it is https (a `javascript:` URL would run in the game's origin). */
export function buyUrl(config: PublicConfig | null): string | null {
  const url = config?.token.buyUrl;
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** What the HUD can ask the game to do (implemented in main.ts). */
export interface GameActions {
  /** Wallet picker when signed out, account menu when signed in. */
  openWallet(): void;
  placeSelected(): void;
  selectColor(index: number): void;
  openReport(): void;
  togglePanel(open?: boolean): void;
  /** Resolves true when the faction was changed. */
  setFaction(name: string | null): Promise<boolean>;
  refreshBalance(): Promise<void>;
  setDevBalance(balance: number): Promise<void>;
}
