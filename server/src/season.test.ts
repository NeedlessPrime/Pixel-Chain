import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { EMPTY, PALETTE, decodeTimelapse } from '@pixel/shared';
import { builtinLogo } from './logo';
import { newSeason } from './season';
import { HOUR_MS, newWallet, startTestApp, testConfig, type TestApp } from './test-helpers';

const ADMIN = { 'x-admin-token': 'admin-test-token' };

function recordEvents(app: TestApp): string[] {
  const seen: string[] = [];
  app.events.on('season', (s) => seen.push(`season:${s.status}${s.chaos.active ? ':chaos' : ''}`));
  app.events.on('reload', (reason) => seen.push(`reload:${reason}`));
  return seen;
}

/** Replays a timelapse onto an empty canvas. */
function replay(bytes: Uint8Array): Uint8Array {
  const tl = decodeTimelapse(bytes);
  const canvas = new Uint8Array(tl.width * tl.height).fill(EMPTY);
  for (let i = 0; i < tl.count; i++) canvas[tl.ys[i]! * tl.width + tl.xs[i]!] = tl.cs[i]!;
  return canvas;
}

describe('season lifecycle (fake clock)', () => {
  it('runs live → chaos → frozen (logo + archive) → break → next season', async () => {
    const app = await startTestApp({
      env: { SEASON_DAYS: '1', CHAOS_HOURS: '6', SEASON_BREAK_MINUTES: '30', SEASON_THEMES: 'Un|Deux' },
    });
    try {
      const seen = recordEvents(app);
      const player = newWallet().wallet;
      app.service.setMockBalance(player, 10_000);
      const t0 = app.clock.now();

      // Live: the slowest tier waits one minute.
      expect(await app.service.place(player, 1, 1, 5)).toMatchObject({ ok: true, nextPlaceAt: t0 + 60_000 });

      // Chaos: the last 6 hours, cooldowns halved, announced once.
      app.clock.advance(18 * HOUR_MS);
      await app.tick();
      await app.tick();
      expect(seen).toEqual(['season:live:chaos']);
      expect(app.service.meCached(player).cooldownMs).toBe(30_000);
      expect(await app.service.place(player, 2, 1, 6)).toMatchObject({ ok: true, nextPlaceAt: app.clock.now() + 30_000 });

      // Freeze: logo stamped bottom-right, archive written.
      app.clock.advance(6 * HOUR_MS);
      await app.tick();
      const frozenAt = app.clock.now();
      expect(app.season.info()).toMatchObject({ status: 'frozen', endsAt: frozenAt, nextSeasonAt: frozenAt + 30 * 60_000 });
      expect(app.season.info().chaos.active).toBe(false);
      const logo = builtinLogo();
      const origin = { x: 64 - logo.width - 2, y: 48 - logo.height - 2 };
      expect(app.service.pixelInfo(origin.x, origin.y)).toMatchObject({ system: true, wallet: null, color: PALETTE.indexOf('#000000') });
      expect(app.service.pixelInfo(63, 47)).toMatchObject({ system: false, color: EMPTY });
      expect(app.service.pixelInfo(1, 1)).toMatchObject({ wallet: player, color: 5 });
      expect(await app.service.place(player, 3, 3, 5)).toMatchObject({ ok: false, code: 'frozen' });

      const dir = path.join(app.dir, 'archive', 's1');
      const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
      expect(meta).toMatchObject({
        id: 's1', number: 1, theme: 'Un', startedAt: t0, endedAt: frozenAt, width: 64, height: 48,
        totalPlacements: 2, uniquePlayers: 1, imageUrl: '/api/seasons/s1/image.png', timelapseUrl: '/api/seasons/s1/timelapse.bin',
      });
      expect(meta.topPlayers[0]).toMatchObject({ wallet: player, pixels: 2 });
      const png = PNG.sync.read(await readFile(path.join(dir, 'image.png')));
      expect([png.width, png.height]).toEqual([64, 48]);
      const timelapse = new Uint8Array(await readFile(path.join(dir, 'timelapse.bin')));
      expect(decodeTimelapse(timelapse).count).toBe(2 + logo.width * logo.height);
      expect(replay(timelapse)).toEqual(app.game.colors);

      const seasons = await app.http.inject('/api/seasons');
      expect(seasons.json()).toEqual([meta]);
      const image = await app.http.inject('/api/seasons/s1/image.png');
      expect([image.statusCode, image.headers['content-type']]).toEqual([200, 'image/png']);
      expect((await app.http.inject('/api/seasons/s9/image.png')).statusCode).toBe(404);

      // Break: nothing changes before nextSeasonAt.
      app.clock.advance(30 * 60_000 - 1);
      await app.tick();
      expect(app.season.state.status).toBe('frozen');

      // Next season: empty canvas, next theme, stats and cooldowns reset.
      app.clock.advance(1);
      await app.tick();
      expect(app.season.info()).toMatchObject({ id: 's2', number: 2, theme: 'Deux', status: 'live', startedAt: app.clock.now() });
      expect(app.game.colors.every((c) => c === EMPTY)).toBe(true);
      expect(seen).toEqual(['season:live:chaos', 'season:frozen', 'season:live', 'reload:season']);
      expect(app.service.meCached(player)).toMatchObject({ placed: 0, owned: 0, nextPlaceAt: 0, cooldownMs: 60_000 });
      expect(await app.service.place(player, 3, 3, 5)).toMatchObject({ ok: true });
      expect(app.service.leaderboard()).toMatchObject({ totalPlacements: 1, uniquePlayers: 1 });
    } finally {
      await app.dispose();
    }
  });

  it('cycles themes with the season number', () => {
    const cfg = testConfig('/unused', { SEASON_THEMES: 'Un|Deux' });
    expect([1, 2, 3].map((n) => newSeason(n, 0, cfg).theme)).toEqual(['Un', 'Deux', 'Un']);
  });

  it('lets an admin end the season early and skip the break', async () => {
    const app = await startTestApp();
    try {
      const seen = recordEvents(app);
      expect((await app.http.inject({ method: 'POST', url: '/api/admin/season/start', headers: ADMIN })).statusCode).toBe(409);
      const end = await app.http.inject({ method: 'POST', url: '/api/admin/season/end', headers: { ...ADMIN, 'content-type': 'application/json' } });
      expect(end.json()).toEqual({ ok: true });
      expect(app.season.info()).toMatchObject({ status: 'frozen', endsAt: app.clock.now() });
      const again = await app.http.inject({ method: 'POST', url: '/api/admin/season/end', headers: ADMIN });
      expect([again.statusCode, again.json().error]).toEqual([409, 'season_frozen']);
      expect((await app.http.inject({ method: 'POST', url: '/api/admin/season/start', headers: ADMIN })).json()).toEqual({ ok: true });
      expect(app.season.info()).toMatchObject({ number: 2, status: 'live' });
      expect(seen).toEqual(['season:frozen', 'season:live', 'reload:season']);
    } finally {
      await app.dispose();
    }
  });

  it('re-renders the archive when the frozen image is moderated', async () => {
    const app = await startTestApp();
    try {
      const player = newWallet().wallet;
      app.service.setMockBalance(player, 1e6);
      await app.service.place(player, 0, 0, 3);
      await app.service.endSeason();
      const timelapsePath = path.join(app.dir, 'archive', 's1', 'timelapse.bin');
      const before = decodeTimelapse(new Uint8Array(await readFile(timelapsePath))).count;
      expect(await app.service.wipe(0, 0, 1, 1)).toBe(1);
      const after = new Uint8Array(await readFile(timelapsePath));
      expect(decodeTimelapse(after).count).toBe(before - 1);
      expect(replay(after)).toEqual(app.game.colors);
    } finally {
      await app.dispose();
    }
  });
});
