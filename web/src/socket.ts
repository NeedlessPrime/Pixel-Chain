import type { ClientMsg, PlaceErrorCode, PublicConfig, ServerMsg } from '@pixel/shared';
import { api, fetchCanvas, type CanvasSnapshot } from './api';
import { syncClock } from './clock';
import type { Connection } from './store';

type PxMsg = Extract<ServerMsg, { t: 'px' }>;
type SeasonMsg = Extract<ServerMsg, { t: 'season' }>;
export type PlaceOk = Extract<ServerMsg, { t: 'ack'; ok: true }>;
export interface PlaceFailure {
  ok: false;
  code: PlaceErrorCode | 'timeout' | 'disconnected';
  message: string;
  nextPlaceAt?: number;
}
export type PlaceResult = PlaceOk | PlaceFailure;

export interface SocketHandlers {
  /** Fresh config + canvas: first load, after a reconnect and on `reload`. */
  onSnapshot(config: PublicConfig, canvas: CanvasSnapshot): void;
  /** Pixel changes newer than the current snapshot, flat [x, y, c, …], in seq order. */
  onPixels(d: number[]): void;
  /** Every other message except `ack` (resolved through `place()`) and `pong`. */
  onMessage(msg: Exclude<ServerMsg, PxMsg | { t: 'ack' } | { t: 'pong' }>): void;
  onStatus(status: Connection): void;
  onSyncError(err: unknown): void;
}

const PING_EVERY_MS = 20_000;
/** No frame at all for this long (pings included) means the link is dead. */
const SILENCE_LIMIT_MS = 50_000;
const ACK_TIMEOUT_MS = 10_000;
/** After `online` or the tab coming back, a ping must be answered this fast or the socket is replaced. */
const PROBE_TIMEOUT_MS = 5_000;
/** A stalled config/canvas request fails the sync (→ reconnect and retry) instead of hanging it. */
const SNAPSHOT_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** A seq gap triggers a resync, but never more often than this (guards against a resync loop). */
const GAP_RESYNC_MIN_INTERVAL_MS = 10_000;

/**
 * WebSocket client implementing the contract's sync algorithm:
 * open the socket and buffer `px` → fetch config + canvas → apply buffered and
 * later `px` whose seq is newer than X-Canvas-Seq. Redone on `reload` and reconnect.
 */
export class GameSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private nextAckId = 1;
  private acks = new Map<number, { resolve: (r: PlaceResult) => void; timer: ReturnType<typeof setTimeout> }>();

  /** Seq of the last pixel applied; -1 until the first snapshot. */
  private seq = -1;
  /**
   * Non-null while a snapshot is being fetched: `px` frames wait here, and so do
   * `season` frames, which must win over the older `config.season` of the snapshot.
   */
  private buffer: (PxMsg | SeasonMsg)[] | null = null;
  /** Bumped on every sync/close so a stale fetch never applies its result. */
  private syncGen = 0;
  private lastGapResyncAt = 0;

  constructor(private readonly handlers: SocketHandlers) {}

  start(): void {
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.checkLink();
    });
    window.addEventListener('online', () => this.checkLink());
  }

  /** Attach (or forget) the session. Dropping a session needs a fresh, anonymous socket. */
  setToken(token: string | null): void {
    const previous = this.token;
    this.token = token;
    if (!this.isOpen()) return;
    if (token) this.send({ t: 'auth', token });
    else if (previous) this.drop();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  place(x: number, y: number, c: number): Promise<PlaceResult> {
    if (!this.isOpen()) return Promise.resolve({ ok: false, code: 'disconnected', message: '' });
    const id = this.nextAckId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        resolve({ ok: false, code: 'timeout', message: '' });
        // No ack in time: the link is probably half-open. Start over with a fresh socket and a resync.
        this.drop();
      }, ACK_TIMEOUT_MS);
      this.acks.set(id, { resolve, timer });
      this.send({ t: 'place', x, y, c, id });
    });
  }

  private connect(): void {
    this.clearReconnect();
    this.handlers.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.lastFrameAt = Date.now();
      this.startPing();
    };
    ws.onmessage = (ev) => {
      this.lastFrameAt = Date.now();
      if (typeof ev.data === 'string') this.receive(ev.data);
    };
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {
      // onclose always follows; reconnection is handled there.
    };
  }

  private receive(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello':
        // The server registers the socket before sending hello, so from now on no px can be missed.
        this.handlers.onStatus('online');
        if (this.token) this.send({ t: 'auth', token: this.token });
        this.handlers.onMessage(msg);
        void this.sync();
        return;
      case 'px':
        if (this.buffer) this.buffer.push(msg);
        else this.applyPx(msg);
        return;
      case 'season':
        if (this.buffer) this.buffer.push(msg);
        else this.handlers.onMessage(msg);
        return;
      case 'ack': {
        if (msg.id === undefined) return;
        const pending = this.acks.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.acks.delete(msg.id);
        pending.resolve(msg);
        return;
      }
      case 'reload':
        this.handlers.onMessage(msg);
        void this.sync();
        return;
      case 'pong':
        return;
      default:
        this.handlers.onMessage(msg);
    }
  }

  private async sync(): Promise<void> {
    const gen = ++this.syncGen;
    this.buffer = [];
    try {
      const config = await api.config(AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS));
      if (gen !== this.syncGen) return;
      syncClock(config.serverTime);
      const canvas = await fetchCanvas(AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS));
      if (gen !== this.syncGen) return;
      this.handlers.onSnapshot(config, canvas);
      this.attempt = 0; // only a full sync proves the link works; a bare hello does not
      this.seq = canvas.seq;
      const buffered = this.buffer;
      this.buffer = null;
      for (const m of buffered) {
        if (m.t === 'px') this.applyPx(m);
        else this.handlers.onMessage(m);
      }
    } catch (err) {
      if (gen !== this.syncGen) return;
      this.handlers.onSyncError(err);
      // Start over from a fresh socket, with backoff.
      this.drop();
    }
  }

  private applyPx(msg: PxMsg): void {
    const count = Math.floor(msg.d.length / 3);
    const last = msg.s + count - 1;
    if (count === 0 || last <= this.seq) return; // already in the snapshot
    if (msg.s > this.seq + 1 && Date.now() - this.lastGapResyncAt > GAP_RESYNC_MIN_INTERVAL_MS) {
      // Pixels went missing between the snapshot and this frame: refetch rather than drift.
      this.lastGapResyncAt = Date.now();
      void this.sync();
      this.buffer?.push(msg);
      return;
    }
    const skip = Math.max(0, this.seq - msg.s + 1);
    this.handlers.onPixels(skip > 0 ? msg.d.slice(skip * 3) : msg.d);
    this.seq = last;
  }

  private send(msg: ClientMsg): void {
    if (this.isOpen()) this.ws!.send(JSON.stringify(msg));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > SILENCE_LIMIT_MS) this.drop();
      else this.send({ t: 'ping' });
    }, PING_EVERY_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Close now without waiting for the browser's (possibly very late) close event. */
  private drop(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    this.handleClose(ws);
  }

  private handleClose(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopPing();
    this.syncGen++;
    this.buffer = null;
    for (const [id, pending] of this.acks) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: 'disconnected', message: '' });
      this.acks.delete(id);
    }
    this.handlers.onStatus('offline');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = ceiling / 2 + Math.random() * (ceiling / 2); // "equal jitter"
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * The network changed or the tab woke up: reconnect now if down, and probe an
   * open socket, which may be half-open (no close event will ever come).
   */
  private checkLink(): void {
    const ws = this.ws;
    if (!ws) return this.connect();
    if (!this.isOpen()) return;
    const sentAt = Date.now();
    this.send({ t: 'ping' });
    setTimeout(() => {
      if (this.ws === ws && this.lastFrameAt < sentAt) this.drop();
    }, PROBE_TIMEOUT_MS);
  }
}
