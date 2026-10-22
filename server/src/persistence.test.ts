import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateSecret } from './persistence';
import { fakeClock, newWallet, removeDir, startTestApp, tempDir } from './test-helpers';

let dir = '';
afterEach(() => removeDir(dir));

describe('persistence', () => {
  it('restores the exact canvas, season, players and cooldowns after a restart', async () => {
    dir = await tempDir();
    const clock = fakeClock();
    const player = newWallet().wallet;

    const first = await startTestApp({ dir, clock });
    first.service.setMockBalance(player, 1_000_000);
    expect(await first.service.place(player, 3, 4, 7)).toMatchObject({ ok: true });
    first.service.setFaction(player, 'Bleus');
    first.service.report(player, { x: 3, y: 4, w: 2, h: 2, reason: 'spam' });
    first.game.ban(newWallet().wallet);
    const before = {
      colors: first.game.colors.slice(),
      owners: first.game.owners.slice(),
      times: first.game.times.slice(),
      seq: first.game.seq,
      season: first.season.info(),
      me: first.service.meCached(player),
      reports: first.service.reports(),
      banned: [...first.game.banned],
    };
    await first.close();
    expect((await readdir(dir)).sort()).toEqual(['canvas.bin', 'log-s1.bin', 'owners.bin', 'state.json', 'times.bin']);

    const second = await startTestApp({ dir, clock });
    expect(second.game.colors).toEqual(before.colors);
    expect(second.game.owners).toEqual(before.owners);
    expect(second.game.times).toEqual(before.times);
    expect(second.game.seq).toBe(before.seq);
    expect(second.season.info()).toEqual(before.season);
    expect(await second.service.me(player)).toEqual(before.me);
    expect(second.service.reports()).toEqual(before.reports);
    expect([...second.game.banned]).toEqual(before.banned);
    expect(second.game.log.count).toBe(1);
    expect(await second.service.place(player, 0, 0, 1)).toMatchObject({ ok: false, code: 'cooldown', nextPlaceAt: clock.now() + 5_000 });

    // The log is appended to on later saves.
    clock.advance(5_000);
    expect(await second.service.place(player, 0, 0, 1)).toMatchObject({ ok: true });
    await second.save();
    await second.close();
    expect((await readFile(path.join(dir, 'log-s1.bin'))).length).toBe(10);

    const third = await startTestApp({ dir, clock });
    expect(third.game.log.count).toBe(2);
    expect(third.service.pixelInfo(0, 0)).toMatchObject({ color: 1, wallet: player, faction: 'Bleus' });
    await third.close();
    expect((await readdir(dir)).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('only rewrites the state when something changed', async () => {
    dir = await tempDir();
    const app = await startTestApp({ dir });
    const stateFile = path.join(dir, 'state.json');
    await app.save();
    await writeFile(stateFile, 'sentinel');
    await app.save();
    expect(await readFile(stateFile, 'utf8')).toBe('sentinel');
    app.service.setMockBalance(newWallet().wallet, 1);
    await app.save();
    expect(JSON.parse(await readFile(stateFile, 'utf8')).version).toBe(1);
    await app.close();
  });

  it('generates and keeps a session secret when none is configured', async () => {
    dir = await tempDir();
    const secret = await loadOrCreateSecret(dir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadOrCreateSecret(dir)).toBe(secret);
  });
});
