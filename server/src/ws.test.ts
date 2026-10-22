import { WebSocket } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NonceResponse, ServerMsg, VerifyResponse } from '@pixel/shared';
import { createSessionToken } from './auth';
import { newWallet, startTestApp, type TestApp } from './test-helpers';
import { parseClientMsg } from './ws';

const MINT = 'So11111111111111111111111111111111111111112';

type Client = InstanceType<typeof WebSocket>;

let app: TestApp;
afterEach(() => app?.dispose());

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  expect(res.ok).toBe(true);
  return (await res.json()) as T;
}

/** Collects every frame; `next` waits for (and removes) the first one matching. */
function connect(base: string) {
  const ws: Client = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const received: ServerMsg[] = [];
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data)) as ServerMsg));
  return {
    ws,
    received,
    closed,
    send: (msg: unknown) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: <T extends ServerMsg['t']>(t: T, match: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true) =>
      vi.waitFor(() => {
        const i = received.findIndex((m) => m.t === t && match(m as Extract<ServerMsg, { t: T }>));
        if (i < 0) throw new Error(`no ${t} yet`);
        return received.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      }, { timeout: 3_000, interval: 10 }),
  };
}

describe('WebSocket /ws', () => {
  it('signs in over REST, authenticates the socket, places a pixel and broadcasts it', async () => {
    app = await startTestApp({ timers: true });
    const base = await app.listen();
    const player = newWallet();
    const { nonce, message } = await postJson<NonceResponse>(`${base}/api/auth/nonce`, { wallet: player.wallet });
    const { token } = await postJson<VerifyResponse>(`${base}/api/auth/verify`, { wallet: player.wallet, nonce, signature: player.sign(message) });
    await postJson(`${base}/api/dev/balance`, { balance: 1_000_000 }, { authorization: `Bearer ${token}` });

    const socket = connect(base);
    expect(await socket.next('hello')).toMatchObject({ protocolVersion: 1, online: 1, seq: 0, season: { id: 's1', status: 'live' } });
    const spectator = connect(base);
    expect(await spectator.next('hello')).toMatchObject({ online: 2 });

    socket.send({ t: 'auth', token });
    expect(await socket.next('authed')).toMatchObject({ ok: true, me: { wallet: player.wallet, tier: { id: 'whale' } } });

    socket.send({ t: 'place', x: 3, y: 4, c: 12, id: 7 });
    expect(await socket.next('ack')).toMatchObject({ id: 7, ok: true, nextPlaceAt: app.clock.now() + 5_000, me: { placed: 1, owned: 1 } });
    expect(await socket.next('px')).toEqual({ t: 'px', s: 1, d: [3, 4, 12] });
    expect(await spectator.next('px')).toEqual({ t: 'px', s: 1, d: [3, 4, 12] });

    socket.send({ t: 'place', x: 3, y: 5, c: 12, id: 8 });
    expect(await socket.next('ack')).toMatchObject({ id: 8, ok: false, code: 'cooldown', message: 'Attends encore 5 s', nextPlaceAt: app.clock.now() + 5_000 });

    socket.send({ t: 'ping' });
    expect(await socket.next('pong')).toEqual({ t: 'pong' });
    expect(spectator.received.some((m) => m.t === 'ack' || m.t === 'me' || m.t === 'authed')).toBe(false);

    // A canvas fetched now includes the pixel and its seq.
    const canvas = await fetch(`${base}/api/canvas`);
    expect(canvas.headers.get('x-canvas-seq')).toBe('1');
    expect(new Uint8Array(await canvas.arrayBuffer())[4 * 64 + 3]).toBe(12);

    socket.ws.close();
    spectator.ws.close();
  });

  it('answers auth from the cached balance, so re-authenticating costs no RPC call', async () => {
    let calls = 0;
    app = await startTestApp({
      timers: true,
      env: { TOKEN_MINT: MINT },
      balanceProvider: { fetchBalance: async () => (calls++, 2_000_000) },
    });
    const base = await app.listen();
    const player = newWallet();
    const { nonce, message } = await postJson<NonceResponse>(`${base}/api/auth/nonce`, { wallet: player.wallet });
    const { token } = await postJson<VerifyResponse>(`${base}/api/auth/verify`, { wallet: player.wallet, nonce, signature: player.sign(message) });
    expect(calls).toBe(1);
    app.clock.advance(10 * 60_000); // well past the balance TTL

    const socket = connect(base);
    await socket.next('hello');
    for (let i = 0; i < 3; i++) {
      socket.send({ t: 'auth', token });
      expect(await socket.next('authed')).toMatchObject({ ok: true, me: { balance: 2_000_000, tier: { id: 'whale' } } });
    }
    expect(calls).toBe(1);
    // A wallet the cache has never seen (e.g. after a restart) is read once.
    const stranger = createSessionToken(newWallet().wallet, 'test-secret-test-secret-test-secret', app.clock.now()).token;
    socket.send({ t: 'auth', token: stranger });
    expect(await socket.next('authed')).toMatchObject({ ok: true, me: { balance: 2_000_000 } });
    expect(calls).toBe(2);
    socket.ws.close();
  });

  it('pushes me only to the sockets of that wallet, following re-auth, failed auth and close', async () => {
    app = await startTestApp({ timers: true });
    const base = await app.listen();
    const [alice, bob] = [newWallet().wallet, newWallet().wallet];
    const token = (wallet: string) => createSessionToken(wallet, 'test-secret-test-secret-test-secret', app.clock.now()).token;
    const [a1, a2, b] = [connect(base), connect(base), connect(base)];
    await Promise.all([a1, a2, b].map((s) => s.next('hello')));
    const auth = async (s: ReturnType<typeof connect>, t: string) => {
      s.send({ t: 'auth', token: t });
      await s.next('authed');
    };
    await Promise.all([auth(a1, token(alice)), auth(a2, token(alice)), auth(b, token(bob))]);
    /** Frames still unread once the socket answered a ping (so nothing is in flight). */
    const pending = async (s: ReturnType<typeof connect>) => {
      s.send({ t: 'ping' });
      await s.next('pong');
      return s.received.filter((m) => m.t === 'me').length;
    };

    app.events.emit('me', alice);
    await a1.next('me', (m) => m.me.wallet === alice);
    await a2.next('me', (m) => m.me.wallet === alice);
    expect(await pending(b)).toBe(0);

    await auth(a2, token(bob));
    app.events.emit('me', alice);
    app.events.emit('me', bob);
    await a1.next('me');
    await a2.next('me', (m) => m.me.wallet === bob);
    await b.next('me', (m) => m.me.wallet === bob);
    expect(await Promise.all([pending(a1), pending(a2), pending(b)])).toEqual([0, 0, 0]);

    await auth(b, 'forged.token');
    app.events.emit('me', bob);
    await a2.next('me');
    expect(await pending(b)).toBe(0);

    const byWallet = (app.hub as unknown as { byWallet: Map<string, Set<unknown>> }).byWallet;
    a1.ws.close();
    await vi.waitFor(() => expect([...byWallet.keys()]).toEqual([bob]));
    a2.ws.close();
    await vi.waitFor(() => expect(byWallet.size).toBe(0));
    b.ws.close();
  });

  it('refuses bad tokens and unauthenticated placements', async () => {
    app = await startTestApp({ timers: true });
    const socket = connect(await app.listen());
    await socket.next('hello');
    socket.send({ t: 'auth', token: 'forged.token' });
    expect(await socket.next('authed')).toEqual({ t: 'authed', ok: false, code: 'unauthenticated' });
    socket.send({ t: 'place', x: 0, y: 0, c: 1, id: 1 });
    expect(await socket.next('ack')).toMatchObject({ id: 1, ok: false, code: 'unauthenticated' });
    socket.send('not json');
    socket.send({ t: 'unknown' });
    socket.send({ t: 'ping' });
    expect(await socket.next('pong')).toEqual({ t: 'pong' });
    socket.ws.close();
  });

  it('rate limits to 10 messages per second and closes on frames over 1 KB', async () => {
    app = await startTestApp({ timers: true });
    const base = await app.listen();
    const socket = connect(base);
    await socket.next('hello');
    for (let id = 1; id <= 12; id++) socket.send({ t: 'place', x: 0, y: 0, c: 1, id });
    const acks = await vi.waitFor(() => {
      const all = socket.received.filter((m) => m.t === 'ack');
      expect(all).toHaveLength(12);
      return all;
    });
    const codes = acks.map((m) => (m.ok ? 'ok' : m.code));
    expect(codes.filter((c) => c === 'unauthenticated')).toHaveLength(10);
    expect(codes.filter((c) => c === 'rate_limited')).toHaveLength(2);

    const big = connect(base);
    await big.next('hello');
    big.send({ t: 'auth', token: 'x'.repeat(2_000) });
    expect(await big.closed).toBe(1009);
    socket.ws.close();
  });
});

describe('parseClientMsg', () => {
  it('keeps known shapes and coerces the rest to values the game rejects', () => {
    expect(parseClientMsg('{"t":"place","x":"1","y":2,"c":3,"id":1.5}')).toEqual({ t: 'place', x: NaN, y: 2, c: 3, id: undefined });
    expect(parseClientMsg('{"t":"auth","token":5}')).toBeNull();
    expect(parseClientMsg('[1]')).toBeNull();
    expect(parseClientMsg('null')).toBeNull();
  });
});
