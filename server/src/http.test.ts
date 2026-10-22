import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY, type MeInfo, type NonceResponse } from '@pixel/shared';
import { newWallet, startTestApp, tempDir, type TestApp, type TestWallet } from './test-helpers';

const ADMIN = { 'x-admin-token': 'admin-test-token' };
const MINT = 'So11111111111111111111111111111111111111112';

let app: TestApp;
afterEach(() => app?.dispose());

async function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.http.inject({ method: 'POST', url, payload: payload as object, headers });
}

/** Full login flow: nonce, signature by the wallet key, verify. */
async function signIn(w: TestWallet = newWallet()): Promise<TestWallet & { auth: Record<string, string> }> {
  const { nonce, message } = (await post('/api/auth/nonce', { wallet: w.wallet })).json<NonceResponse>();
  const res = await post('/api/auth/verify', { wallet: w.wallet, nonce, signature: w.sign(message) });
  expect(res.statusCode).toBe(200);
  return { ...w, auth: { authorization: `Bearer ${res.json().token}` } };
}

describe('auth routes', () => {
  it('signs in with a wallet signature and rejects bad or replayed ones', async () => {
    app = await startTestApp({ env: { PUBLIC_DOMAIN: 'pixel.example' } });
    const alice = newWallet();
    const { nonce, message, expiresAt } = (await post('/api/auth/nonce', { wallet: alice.wallet })).json<NonceResponse>();
    expect(message.startsWith('pixel.example veut que tu te connectes')).toBe(true);
    expect(expiresAt).toBe(app.clock.now() + 5 * 60_000);

    const forged = await post('/api/auth/verify', { wallet: alice.wallet, nonce, signature: newWallet().sign(message) });
    expect([forged.statusCode, forged.json().error]).toEqual([401, 'bad_signature']);

    const ok = await post('/api/auth/verify', { wallet: alice.wallet, nonce, signature: alice.sign(message) });
    expect(ok.json()).toMatchObject({ expiresAt: app.clock.now() + 86_400_000, me: { wallet: alice.wallet, balance: 0, tier: null } });
    const replay = await post('/api/auth/verify', { wallet: alice.wallet, nonce, signature: alice.sign(message) });
    expect([replay.statusCode, replay.json().error]).toEqual([401, 'invalid_nonce']);
  });

  it('keeps a pending login valid while someone else requests nonces for the same wallet', async () => {
    app = await startTestApp();
    const victim = newWallet();
    const mine = (await post('/api/auth/nonce', { wallet: victim.wallet })).json<NonceResponse>();
    for (let i = 0; i < 9; i++) {
      await app.http.inject({ method: 'POST', url: '/api/auth/nonce', payload: { wallet: victim.wallet }, remoteAddress: `10.6.6.${i}` });
    }
    const res = await post('/api/auth/verify', { wallet: victim.wallet, nonce: mine.nonce, signature: victim.sign(mine.message) });
    expect(res.statusCode).toBe(200);
  });

  it('validates inputs and answers JSON errors', async () => {
    app = await startTestApp();
    expect((await post('/api/auth/nonce', { wallet: 'nope' })).json()).toEqual({ error: 'bad_wallet', message: 'Adresse de wallet invalide' });
    const broken = await app.http.inject({ method: 'POST', url: '/api/auth/nonce', payload: '{oops', headers: { 'content-type': 'application/json' } });
    expect([broken.statusCode, broken.json().error]).toEqual([400, 'bad_request']);
    expect((await post('/api/auth/verify', { wallet: newWallet().wallet, nonce: 'x', signature: 5 })).statusCode).toBe(400);
  });

  it('limits /api/auth/* to 10 requests per minute per IP', async () => {
    app = await startTestApp();
    const wallet = newWallet().wallet;
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/nonce', { wallet })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/verify', { wallet, nonce: 'n', signature: 's' })).statusCode).toBe(401);
    const limited = await post('/api/auth/nonce', { wallet });
    expect([limited.statusCode, limited.json().error]).toEqual([429, 'rate_limited']);
    expect((await app.http.inject('/api/health')).statusCode).toBe(200);
  });

  it('behind TRUST_PROXY=1, limits the client IP the proxy appended, whatever the client put before it', async () => {
    app = await startTestApp({ env: { TRUST_PROXY: '1' } });
    const wallet = newWallet().wallet;
    const nonce = (realIp: string, spoofed: string) => app.http.inject({
      method: 'POST', url: '/api/auth/nonce', payload: { wallet }, remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': `${spoofed}, ${realIp}` },
    });
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await nonce('203.0.113.7', `6.6.6.${i}`)).statusCode);
    expect(statuses).toEqual([...Array(10).fill(200), 429, 429]);
    // Another player behind the same proxy has its own counter.
    expect((await nonce('198.51.100.9', '6.6.6.6')).statusCode).toBe(200);
  });
});

describe('player routes', () => {
  it('requires a valid bearer token', async () => {
    app = await startTestApp();
    for (const authorization of [undefined, 'Bearer nope', 'nope']) {
      const res = await app.http.inject({ url: '/api/me', headers: authorization ? { authorization } : {} });
      expect([res.statusCode, res.json().error]).toEqual([401, 'unauthenticated']);
    }
  });

  it('sets a fake balance in mock mode and reports the tier', async () => {
    app = await startTestApp();
    const p = await signIn();
    const me = (await post('/api/dev/balance', { balance: 150_000 }, p.auth)).json<MeInfo>();
    expect(me).toMatchObject({ balance: 150_000, tier: { id: 'holder' }, cooldownMs: 30_000, nextPlaceAt: 0 });
    expect((await app.http.inject({ url: '/api/me?refresh=1', headers: p.auth })).json().balance).toBe(150_000);
    expect((await post('/api/dev/balance', { balance: -1 }, p.auth)).statusCode).toBe(400);
    expect((await post('/api/dev/balance', { balance: '5' }, p.auth)).statusCode).toBe(400);
  });

  it('hides /api/dev/balance outside mock mode', async () => {
    app = await startTestApp({
      env: { MODE: 'live', TOKEN_MINT: MINT },
      balanceProvider: { fetchBalance: async () => 42 },
    });
    const p = await signIn();
    expect((await app.http.inject({ url: '/api/me', headers: p.auth })).json().balance).toBe(42);
    expect((await post('/api/dev/balance', { balance: 1 }, p.auth)).statusCode).toBe(404);
    expect((await app.http.inject('/api/config')).json().token).toEqual({ symbol: '$PIXEL', mint: MINT, buyUrl: `https://pump.fun/coin/${MINT}` });
  });

  it('changes faction at most once per hour', async () => {
    app = await startTestApp();
    const p = await signIn();
    await post('/api/dev/balance', { balance: 10_000 }, p.auth);
    expect((await post('/api/me/faction', { faction: '  Les   Bleus ' }, p.auth)).json().faction).toBe('Les Bleus');
    const locked = await post('/api/me/faction', { faction: null }, p.auth);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: 'faction_locked', message: 'Tu pourras changer de faction dans 60 min' });
    expect((await post('/api/me/faction', { faction: '<b>' }, p.auth)).json().error).toBe('bad_faction');
    app.clock.advance(3_600_000);
    expect((await post('/api/me/faction', { faction: null }, p.auth)).json()).toMatchObject({ faction: null });
  });

  it('keeps reports and factions for holders', async () => {
    app = await startTestApp();
    const p = await signIn();
    const holderOnly = { error: 'not_holder', message: 'Réservé aux holders : garde au moins 10 000 $PIXEL' };
    for (const res of [
      await post('/api/report', { x: 0, y: 0, w: 1, h: 1, reason: 'spam' }, p.auth),
      await post('/api/me/faction', { faction: 'Bleus' }, p.auth),
      await post('/api/me/faction', { faction: null }, p.auth),
    ]) {
      expect([res.statusCode, res.json()]).toEqual([403, holderOnly]);
    }
    expect((await app.http.inject({ url: '/api/admin/reports', headers: ADMIN })).json()).toEqual([]);
    await post('/api/dev/balance', { balance: 9_999 }, p.auth);
    expect((await post('/api/report', { x: 0, y: 0, w: 1, h: 1, reason: 'spam' }, p.auth)).statusCode).toBe(403);
    await post('/api/dev/balance', { balance: 10_000 }, p.auth);
    expect((await post('/api/report', { x: 0, y: 0, w: 1, h: 1, reason: 'spam' }, p.auth)).json()).toEqual({ ok: true });
  });

  it('answers 503 when the balance of an unknown wallet cannot be read', async () => {
    app = await startTestApp({ env: { TOKEN_MINT: MINT }, balanceProvider: { fetchBalance: () => Promise.reject(new Error('down')) } });
    const p = await signIn();
    const res = await post('/api/me/faction', { faction: 'Bleus' }, p.auth);
    expect([res.statusCode, res.json().error]).toEqual([503, 'rpc_unavailable']);
  });

  it('caps open reports at 2000 overall', async () => {
    app = await startTestApp();
    const area = { x: 0, y: 0, w: 1, h: 1, reason: 'spam' };
    for (let i = 0; i < 200; i++) {
      const wallet = `wallet-${i}`;
      app.service.setMockBalance(wallet, 10_000);
      for (let k = 0; k < 10; k++) expect(await app.service.report(wallet, area)).toEqual({ ok: true });
    }
    const p = await signIn();
    await post('/api/dev/balance', { balance: 10_000 }, p.auth);
    const full = await post('/api/report', area, p.auth);
    expect([full.statusCode, full.json()]).toEqual([429, { error: 'too_many_reports', message: 'Trop de signalements en attente, réessaie plus tard' }]);
    expect((await post('/api/admin/reports/1/resolve', {}, ADMIN)).statusCode).toBe(200);
    expect((await post('/api/report', area, p.auth)).json()).toEqual({ ok: true });
  });

  it('accepts reports within limits', async () => {
    app = await startTestApp();
    const p = await signIn();
    await post('/api/dev/balance', { balance: 10_000 }, p.auth);
    const area = { x: 60, y: 40, w: 10, h: 10, reason: 'insulte' };
    for (let i = 0; i < 10; i++) expect((await post('/api/report', area, p.auth)).json()).toEqual({ ok: true });
    expect((await post('/api/report', area, p.auth)).json()).toEqual({ error: 'too_many_reports', message: 'Tu as déjà 10 signalements en attente' });
    expect((await post('/api/report', { ...area, w: 65 }, p.auth)).statusCode).toBe(400);
    expect((await post('/api/report', { ...area, x: 64 }, p.auth)).statusCode).toBe(400);
    const reports = (await app.http.inject({ url: '/api/admin/reports', headers: ADMIN })).json();
    expect(reports).toHaveLength(10);
    expect(reports[0]).toMatchObject({ x: 60, y: 40, w: 4, h: 8, reason: 'insulte', wallet: p.wallet, status: 'open' });
  });
});

describe('public routes', () => {
  it('serves config, canvas with seq headers, pixel info and leaderboard', async () => {
    app = await startTestApp({ env: { FACTIONS: 'Bleus|Rouges' } });
    const player = newWallet().wallet;
    app.service.setMockBalance(player, 1e6);
    await app.service.place(player, 2, 1, 9);

    const config = (await app.http.inject('/api/config')).json();
    expect(config).toMatchObject({ protocolVersion: 1, mode: 'mock', width: 64, height: 48, factions: ['Bleus', 'Rouges'], serverTime: app.clock.now() });
    expect(config.palette).toHaveLength(32);

    const canvas = await app.http.inject('/api/canvas');
    expect(canvas.headers).toMatchObject({
      'content-type': 'application/octet-stream', 'x-canvas-width': '64', 'x-canvas-height': '48', 'x-canvas-seq': '1', 'cache-control': 'no-store',
    });
    expect(canvas.rawPayload).toHaveLength(64 * 48);
    expect(canvas.rawPayload[1 * 64 + 2]).toBe(9);
    expect(canvas.rawPayload[0]).toBe(EMPTY);

    expect((await app.http.inject('/api/pixel?x=2&y=1')).json()).toMatchObject({ color: 9, wallet: player, system: false });
    expect((await app.http.inject('/api/pixel?x=64&y=1')).statusCode).toBe(400);
    expect((await app.http.inject('/api/pixel?x=a&y=1')).statusCode).toBe(400);
    expect((await app.http.inject('/api/leaderboard')).json()).toMatchObject({ totalPlacements: 1, players: [{ wallet: player, pixels: 1 }] });
    expect((await app.http.inject('/api/nope')).json()).toEqual({ error: 'not_found', message: 'Introuvable' });
  });
});

describe('admin routes', () => {
  it('are disabled without ADMIN_TOKEN and protected by x-admin-token', async () => {
    app = await startTestApp({ env: { ADMIN_TOKEN: '' } });
    expect((await app.http.inject({ url: '/api/admin/reports', headers: ADMIN })).json().error).toBe('admin_disabled');
    await app.dispose();
    app = await startTestApp();
    expect((await app.http.inject('/api/admin/reports')).statusCode).toBe(403);
    expect((await app.http.inject({ url: '/api/admin/reports', headers: { 'x-admin-token': 'wrong' } })).statusCode).toBe(403);
    expect((await app.http.inject({ url: '/api/admin/reports', headers: ADMIN })).json()).toEqual([]);
  });

  it('wipes, bans, unbans, resolves reports and resizes', async () => {
    app = await startTestApp();
    const p = await signIn();
    app.service.setMockBalance(p.wallet, 1e6);
    await app.service.place(p.wallet, 5, 5, 3);
    app.clock.advance(5_000);
    await app.service.place(p.wallet, 6, 6, 3);

    expect((await post('/api/admin/wipe', { x: 5, y: 5, w: 1, h: 1 }, ADMIN)).json()).toEqual({ ok: true, erased: 1 });
    expect((await post('/api/admin/wipe', { x: 5, y: 5, w: 0, h: 1 }, ADMIN)).statusCode).toBe(400);
    expect((await post('/api/admin/ban', { wallet: p.wallet, wipe: true }, ADMIN)).json()).toEqual({ ok: true, erased: 1 });
    expect((await app.http.inject({ url: '/api/me', headers: p.auth })).json()).toMatchObject({ banned: true, owned: 0 });
    app.clock.advance(5_000);
    expect(await app.service.place(p.wallet, 1, 1, 1)).toMatchObject({ ok: false, code: 'banned', message: 'Ce wallet est banni' });
    expect((await post('/api/admin/unban', { wallet: p.wallet }, ADMIN)).json()).toEqual({ ok: true });
    expect(await app.service.place(p.wallet, 1, 1, 1)).toMatchObject({ ok: true });

    await post('/api/report', { x: 1, y: 1, w: 1, h: 1, reason: 'test' }, p.auth);
    expect((await post('/api/admin/reports/1/resolve', {}, ADMIN)).json()).toEqual({ ok: true });
    expect((await post('/api/admin/reports/99/resolve', {}, ADMIN)).statusCode).toBe(404);

    const events: string[] = [];
    app.events.on('reload', (r) => events.push(r));
    expect((await post('/api/admin/resize', { width: 80, height: 48 }, ADMIN)).json()).toEqual({ ok: true });
    expect((await post('/api/admin/resize', { width: 70, height: 48 }, ADMIN)).json().error).toBe('bad_size');
    expect((await post('/api/admin/resize', { width: 1001, height: 48 }, ADMIN)).statusCode).toBe(400);
    expect(events).toEqual(['resize']);
    expect((await app.http.inject('/api/canvas')).headers['x-canvas-width']).toBe('80');
    expect(app.service.pixelInfo(1, 1)).toMatchObject({ wallet: p.wallet });
  });
});

describe('admin owners lookup', () => {
  it('lists who painted an area, most pixels first, without empty cells or the logo', async () => {
    app = await startTestApp();
    const [alice, bob] = [newWallet().wallet, newWallet().wallet];
    for (const w of [alice, bob]) app.service.setMockBalance(w, 1e6);
    expect(await app.service.setFaction(bob, 'Bleus')).toEqual({ ok: true });
    await app.service.place(bob, 1, 1, 3);
    await app.service.place(alice, 2, 1, 4);
    app.clock.advance(5_000);
    await app.service.place(alice, 2, 2, 4);
    app.clock.advance(5_000);
    await app.service.place(alice, 63, 47, 4); // outside the area below
    app.game.stamp({ width: 1, height: 1, pixels: Uint8Array.from([5]) }, 0, 0, app.clock.now());

    const owners = (q: string) => app.http.inject({ url: `/api/admin/owners?${q}`, headers: ADMIN });
    expect((await owners('x=0&y=0&w=4&h=4')).json()).toEqual({
      owners: [{ wallet: alice, faction: null, pixels: 2 }, { wallet: bob, faction: 'Bleus', pixels: 1 }],
    });
    // Clipped to the canvas.
    expect((await owners('x=63&y=47&w=64&h=64')).json()).toEqual({ owners: [{ wallet: alice, faction: null, pixels: 1 }] });
    expect((await owners('x=0&y=0&w=1&h=1')).json()).toEqual({ owners: [] });
    for (const bad of ['x=0&y=0&w=65&h=1', 'x=0&y=0&w=0&h=1', 'x=64&y=0&w=1&h=1', 'x=0&y=0&w=1']) {
      expect((await owners(bad)).statusCode).toBe(400);
    }
    expect((await app.http.inject('/api/admin/owners?x=0&y=0&w=1&h=1')).statusCode).toBe(403);
  });
});

describe('static web build', () => {
  it('serves WEB_DIST, with /hall and /admin pages', async () => {
    const dir = await tempDir();
    const web = path.join(dir, 'dist');
    await mkdir(path.join(web, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(path.join(web, 'index.html'), '<h1>jeu</h1>'),
      writeFile(path.join(web, 'hall.html'), '<h1>hall</h1>'),
      writeFile(path.join(web, 'admin.html'), '<h1>admin</h1>'),
      writeFile(path.join(web, 'assets', 'app-1a2b.js'), 'console.log(1)'),
    ]);
    app = await startTestApp({ dir, env: { WEB_DIST: web } });
    expect(app.servesWeb).toBe(true);
    const index = await app.http.inject('/');
    expect([index.body, index.headers['cache-control']]).toEqual(['<h1>jeu</h1>', 'no-cache']);
    expect((await app.http.inject('/hall')).body).toBe('<h1>hall</h1>');
    expect((await app.http.inject('/admin')).body).toBe('<h1>admin</h1>');
    expect((await app.http.inject('/assets/app-1a2b.js')).headers['cache-control']).toContain('immutable');
    expect((await app.http.inject('/missing.js')).statusCode).toBe(404);
    expect((await app.http.inject('/api/nope')).json().error).toBe('not_found');
  });
});

describe('placement messages', () => {
  it('explains rejections in French', async () => {
    app = await startTestApp();
    const player = newWallet().wallet;
    expect(await app.service.place(player, 0, 0, 1)).toEqual({
      ok: false, code: 'not_holder', message: 'Achète au moins 10 000 $PIXEL pour jouer',
    });
    app.service.setMockBalance(player, 10_000);
    await app.service.place(player, 0, 0, 1);
    app.clock.advance(47_500);
    expect(await app.service.place(player, 0, 0, 1)).toMatchObject({ code: 'cooldown', message: 'Attends encore 13 s' });
    expect(await app.service.place(null, 0, 0, 1)).toMatchObject({ code: 'unauthenticated' });
  });

  it('answers rpc_unavailable when balances cannot be read', async () => {
    app = await startTestApp({ balanceProvider: { fetchBalance: () => Promise.reject(new Error('down')) } });
    expect(await app.service.place(newWallet().wallet, 0, 0, 1)).toMatchObject({ ok: false, code: 'rpc_unavailable' });
  });
});
