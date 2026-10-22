import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@pixel/shared';
import type { ServerEvents } from './events';
import type { PixelService } from './service';

/** Larger frames close the socket (enforced by ws via maxPayload). */
export const MAX_FRAME_BYTES = 1024;
const PX_INTERVAL_MS = 50;
const LB_INTERVAL_MS = 5_000;
const ONLINE_INTERVAL_MS = 1_000;
const HEARTBEAT_MS = 30_000;
const MAX_MSGS_PER_SECOND = 10;
/** Past this many messages in one second the socket is closed instead of answered. */
const ABUSIVE_MSGS_PER_SECOND = 30;
const MAX_PX_PER_FRAME = 4096;
/** A client this far behind is too slow to follow the canvas: drop it, it will reconnect and reload. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

interface Client {
  socket: WebSocket;
  wallet: string | null;
  sessionExpiresAt: number;
  windowStart: number;
  messages: number;
  alive: boolean;
  /** Messages of one socket are handled in order. */
  queue: Promise<void>;
}

/** Validates the shape of a client frame; numbers are range-checked later by the game. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : NaN);
  switch (m.t) {
    case 'ping':
      return { t: 'ping' };
    case 'auth':
      return typeof m.token === 'string' ? { t: 'auth', token: m.token } : null;
    case 'place':
      return { t: 'place', x: num(m.x), y: num(m.y), c: num(m.c), id: Number.isSafeInteger(m.id) ? (m.id as number) : undefined };
    default:
      return null;
  }
}

/** All live sockets: per-socket protocol handling plus the batched broadcasts. */
export class Hub {
  private readonly clients = new Set<Client>();
  private timers: NodeJS.Timeout[] = [];
  private sentOnline = 0;
  private sentLbVersion = -1;

  constructor(
    private readonly service: PixelService,
    events: ServerEvents,
    private readonly now: () => number,
    private readonly log: FastifyBaseLogger,
  ) {
    events.on('season', (season) => this.broadcast({ t: 'season', season }));
    events.on('reload', (reason) => this.broadcast({ t: 'reload', reason }));
    events.on('me', (wallet) => this.pushMe(wallet));
    events.on('allMe', () => this.pushMe());
  }

  get online(): number {
    return this.clients.size;
  }

  start(): void {
    this.timers = [
      setInterval(() => this.flushPixels(), PX_INTERVAL_MS),
      setInterval(() => this.flushLeaderboard(), LB_INTERVAL_MS),
      setInterval(() => this.flushOnline(), ONLINE_INTERVAL_MS),
      setInterval(() => this.heartbeat(), HEARTBEAT_MS),
    ];
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.flushPixels();
    for (const client of this.clients) client.socket.close(1001, 'server shutdown');
    this.clients.clear();
  }

  attach(socket: WebSocket): void {
    const client: Client = {
      socket, wallet: null, sessionExpiresAt: 0, windowStart: 0, messages: 0, alive: true, queue: Promise.resolve(),
    };
    this.clients.add(client);
    socket.on('message', (data, isBinary) => this.receive(client, data, isBinary));
    socket.on('pong', () => (client.alive = true));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => socket.terminate());
    const { game, season } = this.service;
    this.send(client, { t: 'hello', protocolVersion: PROTOCOL_VERSION, online: this.clients.size, seq: game.seq, season: season.info() });
  }

  /** Broadcasts pending pixel changes as `px` frames (also called before any state change message). */
  flushPixels(): void {
    const batch = this.service.game.drainPixels();
    if (!batch) return;
    const step = MAX_PX_PER_FRAME * 3;
    for (let i = 0; i < batch.d.length; i += step) {
      this.broadcast({ t: 'px', s: batch.s + i / 3, d: batch.d.slice(i, i + step) });
    }
  }

  private receive(client: Client, data: RawData, isBinary: boolean): void {
    if (!this.withinRate(client)) {
      if (client.messages > ABUSIVE_MSGS_PER_SECOND) return client.socket.close(1008, 'rate limit');
      const msg = isBinary ? null : parseClientMsg(data.toString());
      if (msg?.t === 'place') this.send(client, { t: 'ack', id: msg.id, ...this.service.placeRejection('rate_limited') });
      return;
    }
    const msg = isBinary ? null : parseClientMsg(data.toString());
    if (!msg) return;
    client.queue = client.queue
      .then(() => this.handle(client, msg))
      .catch((err) => this.log.error({ err }, 'websocket message failed'));
  }

  private async handle(client: Client, msg: ClientMsg): Promise<void> {
    switch (msg.t) {
      case 'ping':
        return this.send(client, { t: 'pong' });
      case 'auth':
        return this.authenticate(client, msg.token);
      case 'place': {
        const result = await this.service.place(this.walletOf(client), msg.x, msg.y, msg.c);
        return this.send(client, { t: 'ack', id: msg.id, ...result });
      }
    }
  }

  private async authenticate(client: Client, token: string): Promise<void> {
    const session = this.service.session(token);
    if (!session) {
      client.wallet = null;
      return this.send(client, { t: 'authed', ok: false, code: 'unauthenticated' });
    }
    client.wallet = session.wallet;
    client.sessionExpiresAt = session.expiresAt;
    this.send(client, { t: 'authed', ok: true, me: await this.service.me(session.wallet) });
  }

  /** The socket's wallet while its session token is still valid. */
  private walletOf(client: Client): string | null {
    return client.wallet && this.now() < client.sessionExpiresAt ? client.wallet : null;
  }

  /** Fixed one-second window on the real clock (transport concern, independent of the game clock). */
  private withinRate(client: Client): boolean {
    const t = performance.now();
    if (t - client.windowStart >= 1000) {
      client.windowStart = t;
      client.messages = 0;
    }
    return ++client.messages <= MAX_MSGS_PER_SECOND;
  }

  private flushLeaderboard(): void {
    const { game } = this.service;
    if (this.clients.size > 0 && game.version !== this.sentLbVersion) {
      this.sentLbVersion = game.version;
      this.broadcast({ t: 'lb', lb: this.service.leaderboard() });
    }
    // Players whose pixels were painted over get their new `owned` count at the same pace.
    for (const wallet of game.drainOwnedChanged()) this.pushMe(wallet);
  }

  private flushOnline(): void {
    if (this.clients.size === this.sentOnline) return;
    this.sentOnline = this.clients.size;
    this.broadcast({ t: 'online', n: this.sentOnline });
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  /** `me` to the sockets of one wallet, or of every authenticated wallet. */
  private pushMe(wallet?: string): void {
    for (const client of this.clients) {
      const w = this.walletOf(client);
      if (w && (wallet === undefined || w === wallet)) this.send(client, { t: 'me', me: this.service.meCached(w) });
    }
  }

  private broadcast(msg: ServerMsg): void {
    // Pixels changed before a season/reload message must reach clients before it.
    if (msg.t === 'season' || msg.t === 'reload') this.flushPixels();
    const data = JSON.stringify(msg);
    for (const client of this.clients) this.sendRaw(client, data);
  }

  private send(client: Client, msg: ServerMsg): void {
    this.sendRaw(client, JSON.stringify(msg));
  }

  private sendRaw(client: Client, data: string): void {
    const { socket } = client;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return socket.terminate();
    socket.send(data);
  }
}

export function registerWs(app: FastifyInstance, hub: Hub): void {
  app.get('/ws', { websocket: true }, (socket) => hub.attach(socket));
}
