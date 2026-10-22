import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, EMPTY, effectiveCooldownMs, type Tier } from '@pixel/shared';
import { FACTION_CHANGE_INTERVAL_MS, Game, SYSTEM_OWNER, type PlaceContext } from './game';
import { newWallet } from './test-helpers';

const T0 = Date.UTC(2026, 0, 5);
const WHALE = 1_000_000;
const alice = newWallet().wallet;
const bob = newWallet().wallet;

function ctx(over: Partial<PlaceContext> & { chaos?: boolean } = {}): PlaceContext {
  const { chaos = false, ...rest } = over;
  return {
    now: T0,
    live: true,
    balance: WHALE,
    tiers: DEFAULT_TIERS,
    cooldownMs: (t: Tier) => effectiveCooldownMs(t, chaos, 0.5),
    ...rest,
  };
}

describe('tiers and cooldowns', () => {
  it.each([
    [10_000, 60_000],
    [99_999, 60_000],
    [100_000, 30_000],
    [1_000_000, 5_000],
  ])('balance %d -> cooldown %d ms', (balance, cooldown) => {
    const game = new Game(8, 8, T0);
    const res = game.place(alice, 0, 0, 1, ctx({ balance }));
    expect(res.ok && res.player.nextPlaceAt).toBe(T0 + cooldown);
  });

  it('halves cooldowns during chaos, never below the 1 s floor', () => {
    const game = new Game(8, 8, T0);
    const res = game.place(alice, 0, 0, 1, ctx({ balance: 10_000, chaos: true }));
    expect(res.ok && res.player.nextPlaceAt).toBe(T0 + 30_000);
    expect(effectiveCooldownMs(DEFAULT_TIERS[0]!, true, 0.01)).toBe(1_000);
  });

  it('enforces the cooldown server-side and allows placing exactly when it ends', () => {
    const game = new Game(8, 8, T0);
    game.place(alice, 0, 0, 1, ctx());
    expect(game.place(alice, 1, 0, 1, ctx({ now: T0 + 4_999 }))).toEqual({ ok: false, code: 'cooldown', nextPlaceAt: T0 + 5_000 });
    expect(game.place(alice, 1, 0, 1, ctx({ now: T0 + 5_000 })).ok).toBe(true);
  });
});

describe('placement checks, in the documented order', () => {
  const code = (game: Game, wallet: string | null, x: number, y: number, c: number, over: Partial<PlaceContext> = {}) => {
    const res = game.place(wallet, x, y, c, ctx(over));
    return res.ok ? 'ok' : res.code;
  };

  it('authenticated → live → bounds → colour → banned → tier → cooldown', () => {
    const game = new Game(8, 8, T0);
    game.ban(bob);
    expect(code(game, null, -1, 0, 99, { live: false })).toBe('unauthenticated');
    expect(code(game, alice, -1, 0, 99, { live: false })).toBe('frozen');
    expect(code(game, alice, -1, 0, 99)).toBe('out_of_bounds');
    expect(code(game, bob, 0, 0, 99)).toBe('bad_color');
    expect(code(game, bob, 0, 0, 1, { balance: 0 })).toBe('banned');
    expect(code(game, alice, 0, 0, 1, { balance: null })).toBe('rpc_unavailable');
    expect(code(game, alice, 0, 0, 1, { balance: 9_999 })).toBe('not_holder');
    expect(code(game, alice, 0, 0, 1)).toBe('ok');
    expect(code(game, alice, 0, 0, 1, { balance: 0 })).toBe('not_holder');
    expect(code(game, alice, 0, 0, 1)).toBe('cooldown');
  });

  it.each([[8, 0], [0, 8], [1.5, 0], [Number.NaN, 0], [0, -1]])('rejects (%s, %s) as out of bounds', (x, y) => {
    expect(code(new Game(8, 8, T0), alice, x, y, 1)).toBe('out_of_bounds');
  });

  it.each([32, -1, 2.5, EMPTY, Number.NaN])('rejects colour %s', (c) => {
    expect(code(new Game(8, 8, T0), alice, 0, 0, c)).toBe('bad_color');
  });

  it('does not create players for rejected wallets', () => {
    const game = new Game(8, 8, T0);
    game.place(alice, 0, 0, 1, ctx({ balance: 0 }));
    expect(game.player(alice)).toBeUndefined();
  });
});

describe('canvas writes', () => {
  it('tracks owners, counts and seq when pixels are painted over', () => {
    const game = new Game(8, 8, T0);
    game.place(alice, 2, 3, 5, ctx());
    expect(game.player(alice)).toMatchObject({ placed: 1, owned: 1 });
    game.place(bob, 2, 3, 6, ctx({ now: T0 + 2_000 }));
    expect(game.player(alice)).toMatchObject({ placed: 1, owned: 0 });
    expect(game.player(bob)).toMatchObject({ placed: 1, owned: 1 });
    expect(game.pixelInfo(2, 3)).toEqual({
      x: 2, y: 3, color: 6, wallet: bob, faction: null, placedAt: T0 + 2_000, system: false,
    });
    expect(game.seq).toBe(2);
    expect(game.totalPlacements).toBe(2);
  });

  it('lets a player repaint its own pixel with the same colour (costs a cooldown, keeps ownership)', () => {
    const game = new Game(8, 8, T0);
    game.place(alice, 0, 0, 5, ctx());
    const again = game.place(alice, 0, 0, 5, ctx({ now: T0 + 5_000 }));
    expect(again.ok && again.player.nextPlaceAt).toBe(T0 + 10_000);
    expect(game.player(alice)).toMatchObject({ placed: 2, owned: 1 });
  });

  it('queues changes for broadcast with consecutive sequence numbers', () => {
    const game = new Game(8, 8, T0);
    game.place(alice, 1, 1, 2, ctx());
    expect(game.drainPixels()).toEqual({ s: 1, d: [1, 1, 2] });
    expect(game.drainPixels()).toBeNull();
    game.place(bob, 2, 2, 3, ctx());
    game.wipeRect(0, 0, 8, 8, T0);
    expect(game.drainPixels()).toEqual({ s: 2, d: [2, 2, 3, 1, 1, EMPTY, 2, 2, EMPTY] });
    expect(game.seq).toBe(4);
  });

  it('wipes a clipped rectangle and the pixels of a banned wallet', () => {
    const game = new Game(8, 8, T0);
    game.place(alice, 0, 0, 1, ctx());
    game.place(alice, 7, 7, 1, ctx({ now: T0 + 5_000 }));
    game.place(bob, 1, 0, 2, ctx());
    expect(game.wipeRect(-5, -5, 7, 6, T0)).toBe(2);
    expect(game.wipeRect(-5, -5, 7, 6, T0)).toBe(0);
    expect(game.player(bob)?.owned).toBe(0);
    expect(game.pixelInfo(0, 0)).toMatchObject({ color: EMPTY, wallet: null, placedAt: null });
    expect(game.wipeOwner(alice, T0)).toBe(1);
    expect(game.colors[63]).toBe(EMPTY);
    expect(game.player(alice)?.owned).toBe(0);
  });

  it('stamps system pixels, clipped to the canvas', () => {
    const game = new Game(4, 4, T0);
    game.place(alice, 3, 3, 1, ctx());
    const logo = { width: 3, height: 2, pixels: Uint8Array.from([31, EMPTY, 31, 27, 27, 27]) };
    expect(game.stamp(logo, 2, 2, T0 + 60_000)).toBe(3);
    expect(game.pixelInfo(3, 3)).toMatchObject({ color: 27, system: true, wallet: null, placedAt: T0 + 60_000 });
    expect(game.owners[2 * 4 + 2]).toBe(SYSTEM_OWNER);
    expect(game.player(alice)?.owned).toBe(0);
  });

  it('grows the canvas keeping the content top-left', () => {
    const game = new Game(4, 3, T0);
    game.place(alice, 3, 2, 7, ctx());
    game.resize(6, 5);
    expect([game.width, game.height]).toEqual([6, 5]);
    expect(game.pixelInfo(3, 2)).toMatchObject({ color: 7, wallet: alice });
    expect(game.colors.filter((c) => c !== EMPTY)).toHaveLength(1);
    expect(() => game.resize(5, 5)).toThrow();
  });

  it('resets per-season stats but keeps factions, bans and seq', () => {
    const game = new Game(4, 4, T0);
    game.place(alice, 0, 0, 1, ctx());
    game.setFaction(alice, 'Bleus', T0);
    game.ban(bob);
    game.reset(5, 5, T0 + 1);
    expect(game.player(alice)).toMatchObject({ placed: 0, owned: 0, nextPlaceAt: 0, faction: 'Bleus' });
    expect(game.banned.has(bob)).toBe(true);
    expect(game.seq).toBe(1);
    expect(game.colors.every((c) => c === EMPTY)).toBe(true);
    expect(game.log.count).toBe(0);
  });

  it('restores from a snapshot, recounting owned pixels', () => {
    const game = new Game(4, 4, T0);
    game.place(alice, 0, 0, 1, ctx());
    game.place(bob, 1, 0, 2, ctx());
    const copy = Game.restore(game.snapshot(), game.colors.slice(), game.owners.slice(), game.times.slice(), game.log.bytes());
    expect(copy.player(alice)).toEqual(game.player(alice));
    expect(copy.seq).toBe(2);
    expect(copy.log.count).toBe(2);
    expect(() => Game.restore(game.snapshot(), new Uint8Array(3), game.owners, game.times, new Uint8Array())).toThrow();
  });

  it('restores a canvas that references players the snapshot does not know', () => {
    const game = new Game(4, 4, T0);
    game.place(alice, 0, 0, 1, ctx());
    const older = game.snapshot();
    game.place(bob, 1, 0, 2, ctx());
    const copy = Game.restore(older, game.colors.slice(), game.owners.slice(), game.times.slice(), game.log.bytes());
    expect(copy.pixelInfo(1, 0)).toMatchObject({ color: 2, wallet: null, placedAt: null });
    expect(copy.player(alice)?.owned).toBe(1);
    const carol = newWallet().wallet;
    copy.place(carol, 2, 0, 3, ctx());
    expect(copy.player(carol)).toMatchObject({ id: 3, owned: 1 });
    expect(copy.pixelInfo(1, 0).wallet).toBeNull();
    // nextPlayerId never falls behind a known player id.
    const behind = Game.restore({ ...game.snapshot(), nextPlayerId: 2 }, game.colors, game.owners, game.times, new Uint8Array());
    expect(behind.ensurePlayer(carol).id).toBe(4);
  });
});

describe('factions and leaderboard', () => {
  it('counts territory per faction, and pixels follow their owner when it switches', () => {
    const game = new Game(8, 8, T0);
    const carol = newWallet().wallet;
    game.setFaction(alice, 'Bleus', T0);
    game.setFaction(carol, 'Bleus', T0);
    game.setFaction(bob, 'Rouges', T0);
    for (const [wallet, x] of [[alice, 0], [carol, 1], [bob, 2]] as const) game.place(wallet, x, 0, 1, ctx());
    game.place(bob, 3, 0, 1, ctx({ now: T0 + 5_000 }));
    game.place(bob, 4, 0, 1, ctx({ now: T0 + 10_000 }));

    let lb = game.leaderboard(T0);
    expect(lb.factions).toEqual([
      { faction: 'Rouges', pixels: 3, players: 1 },
      { faction: 'Bleus', pixels: 2, players: 2 },
    ]);
    expect(lb.players[0]).toEqual({ wallet: bob, faction: 'Rouges', pixels: 3, placed: 3 });
    expect([lb.totalPlacements, lb.uniquePlayers]).toEqual([5, 3]);

    game.setFaction(alice, 'Rouges', T0 + FACTION_CHANGE_INTERVAL_MS);
    lb = game.leaderboard(T0 + FACTION_CHANGE_INTERVAL_MS);
    expect(lb.factions[0]).toEqual({ faction: 'Rouges', pixels: 4, players: 2 });
  });

  it('allows one faction change per hour', () => {
    const game = new Game(8, 8, T0);
    expect(game.setFaction(alice, 'Bleus', T0)).toEqual({ ok: true });
    expect(game.setFaction(alice, 'Bleus', T0 + 1)).toEqual({ ok: true });
    expect(game.setFaction(alice, null, T0 + 1)).toEqual({ ok: false, lockedUntil: T0 + FACTION_CHANGE_INTERVAL_MS });
    expect(game.setFaction(alice, null, T0 + FACTION_CHANGE_INTERVAL_MS)).toEqual({ ok: true });
    expect(game.player(alice)?.faction).toBeNull();
  });

  it('hides banned wallets', () => {
    const game = new Game(8, 8, T0);
    game.place(alice, 0, 0, 1, ctx());
    game.ban(alice);
    expect(game.leaderboard(T0).players).toEqual([]);
  });
});
