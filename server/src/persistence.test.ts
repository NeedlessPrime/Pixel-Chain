import { appendFile, mkdir, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATE_VERSION, loadOrCreateSecret, writeFileAtomic } from './persistence';
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
    expect(await first.service.setFaction(player, 'Bleus')).toEqual({ ok: true });
    expect(await first.service.report(player, { x: 3, y: 4, w: 2, h: 2, reason: 'spam' })).toEqual({ ok: true });
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
    expect((await readdir(dir)).sort()).toEqual(['log-s1.bin', 'snapshot.bin']);

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
    const snapshotFile = path.join(dir, 'snapshot.bin');
    await app.save();
    await writeFile(snapshotFile, 'sentinel');
    await app.save();
    expect(await readFile(snapshotFile, 'utf8')).toBe('sentinel');
    app.service.setMockBalance(newWallet().wallet, 1);
    await app.save();
    expect((await readFile(snapshotFile)).length).toBeGreaterThan(64 * 48 * 9);
    await app.close();
  });

  it('boots from a torn legacy layout (canvas newer than state.json) and migrates it to snapshot.bin', async () => {
    dir = await tempDir();
    const clock = fakeClock();
    const app = await startTestApp({ dir, clock });
    const [a, b, c] = [newWallet().wallet, newWallet().wallet, newWallet().wallet];
    for (const w of [a, b, c]) app.service.setMockBalance(w, 1e6);
    await app.service.place(a, 1, 1, 3);
    const stateJson = JSON.stringify({
      version: STATE_VERSION, season: app.season.state, game: app.game.snapshot(), reports: { nextId: 1, reports: [] },
    });
    // b is painted on the binaries but unknown to the older state.json, as after a crash between the renames.
    await app.service.place(b, 2, 2, 4);
    const binaries = { colors: app.game.colors.slice(), owners: app.game.owners.slice(), times: app.game.times.slice() };
    await app.close();
    await rm(path.join(dir, 'snapshot.bin'));
    const file = (name: string) => path.join(dir, name);
    await writeFile(file('state.json'), stateJson);
    await writeFile(file('canvas.bin'), binaries.colors);
    await writeFile(file('owners.bin'), new Uint8Array(binaries.owners.buffer));
    await writeFile(file('times.bin'), new Uint8Array(binaries.times.buffer));

    const second = await startTestApp({ dir, clock });
    expect(second.service.pixelInfo(1, 1)).toMatchObject({ color: 3, wallet: a });
    expect(second.service.pixelInfo(2, 2)).toMatchObject({ color: 4, wallet: null, placedAt: null });
    expect(second.game.player(a)?.owned).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['log-s1.bin', 'snapshot.bin']);
    // The next new player gets a fresh id and does not inherit the orphaned cell.
    second.service.setMockBalance(c, 1e6);
    expect(await second.service.place(c, 5, 5, 1)).toMatchObject({ ok: true, me: { owned: 1 } });
    await second.close();

    const third = await startTestApp({ dir, clock });
    expect(third.service.pixelInfo(5, 5)).toMatchObject({ wallet: c });
    expect(third.service.pixelInfo(2, 2)).toMatchObject({ color: 4, wallet: null });
    await third.close();
  });

  it('drops log records written after the last snapshot landed', async () => {
    dir = await tempDir();
    const clock = fakeClock();
    const app = await startTestApp({ dir, clock });
    const player = newWallet().wallet;
    app.service.setMockBalance(player, 1e6);
    await app.service.place(player, 1, 1, 3);
    await app.close();
    const logFile = path.join(dir, 'log-s1.bin');
    // A save appended these, then crashed before renaming its snapshot.
    await appendFile(logFile, new Uint8Array([2, 0, 2, 0, 4, 9, 9]));

    const second = await startTestApp({ dir, clock });
    expect(second.game.log.count).toBe(1);
    await second.save(true);
    expect((await readFile(logFile)).length).toBe(5);
    await second.close();
  });

  it('refuses a snapshot whose size does not match its canvas', async () => {
    dir = await tempDir();
    const app = await startTestApp({ dir });
    await app.close();
    await truncate(path.join(dir, 'snapshot.bin'), 1000);
    await expect(startTestApp({ dir })).rejects.toThrow(/snapshot\.bin/);
  });

  it('never leaves temporary files behind', async () => {
    dir = await tempDir();
    // A failed write removes its temporary file…
    await mkdir(path.join(dir, 'taken'));
    await expect(writeFileAtomic(path.join(dir, 'taken'), 'x')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['taken']);
    // …and boot removes those of writes a crash interrupted.
    await writeFile(path.join(dir, 'snapshot.bin.123.4.tmp'), 'half');
    await mkdir(path.join(dir, 'archive', 's1'), { recursive: true });
    await writeFile(path.join(dir, 'archive', 's1', 'image.png.123.5.tmp'), 'half');
    const app = await startTestApp({ dir });
    expect((await readdir(dir)).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(await readdir(path.join(dir, 'archive', 's1'))).toEqual([]);
    await app.close();
  });

  it('generates and keeps a session secret when none is configured', async () => {
    dir = await tempDir();
    const secret = await loadOrCreateSecret(dir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadOrCreateSecret(dir)).toBe(secret);
  });
});
