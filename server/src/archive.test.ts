import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { DEFAULT_TIERS, EMPTY, EMPTY_COLOR, PALETTE, decodeTimelapse, effectiveCooldownMs, hexToRgb } from '@pixel/shared';
import { buildTimelapse, renderPng } from './archive';
import { Game, type PlaceContext } from './game';
import { PlacementLog, scrubModerated } from './log';
import { newWallet } from './test-helpers';

const T0 = Date.UTC(2026, 0, 5);
const alice = newWallet().wallet;
const bob = newWallet().wallet;

/** Every placement passes the cooldown: the clock jumps a minute each time. */
function painter(game: Game) {
  let t = T0;
  const ctx = (): PlaceContext => ({
    now: (t += 60_000), live: true, balance: 1e6, tiers: DEFAULT_TIERS, cooldownMs: (tier) => effectiveCooldownMs(tier, false, 1),
  });
  return (wallet: string, x: number, y: number, c: number) => {
    const res = game.place(wallet, x, y, c, ctx());
    if (!res.ok) throw new Error(res.code);
  };
}

/** Replays a timelapse onto an empty canvas. */
function replay(bytes: Uint8Array): Uint8Array {
  const tl = decodeTimelapse(bytes);
  const canvas = new Uint8Array(tl.width * tl.height).fill(EMPTY);
  for (let i = 0; i < tl.count; i++) canvas[tl.ys[i]! * tl.width + tl.xs[i]!] = tl.cs[i]!;
  return canvas;
}

describe('PlacementLog', () => {
  it('stores records in the timelapse layout and drops a partial trailing record', () => {
    const log = new PlacementLog();
    for (let i = 0; i < 1000; i++) log.append(i, 999 - i, i % 32);
    const reloaded = new PlacementLog(Uint8Array.from([...log.bytes(), 1, 2]));
    expect(reloaded.count).toBe(1000);
    expect(scrubModerated(reloaded.bytes(), 1000, 1000)[999]).toEqual({ x: 999, y: 0, c: 999 % 32 });
  });
});

describe('timelapse moderation scrubbing', () => {
  it('drops every record of a cell erased later by an admin wipe, keeps later paint', () => {
    const game = new Game(8, 8, T0);
    const paint = painter(game);
    paint(alice, 1, 1, 3);
    paint(bob, 2, 2, 4);
    paint(bob, 1, 1, 5);
    game.wipeRect(1, 1, 1, 1, T0);
    paint(alice, 1, 1, 6);

    expect(scrubModerated(game.log.bytes(), 8, 8)).toEqual([{ x: 2, y: 2, c: 4 }, { x: 1, y: 1, c: 6 }]);
    const timelapse = buildTimelapse(game.log.bytes(), 8, 8);
    expect(decodeTimelapse(timelapse).count).toBe(2);
    expect(replay(timelapse)).toEqual(game.colors);
  });

  it('removes what a ban wiped but keeps the banned pixels others had already covered', () => {
    const game = new Game(8, 8, T0);
    const paint = painter(game);
    paint(bob, 0, 0, 1); // covered by alice below: not erased by the ban
    paint(alice, 0, 0, 2);
    paint(bob, 3, 3, 7);
    game.ban(bob);
    expect(game.wipeOwner(bob, T0)).toBe(1);

    const records = scrubModerated(game.log.bytes(), 8, 8);
    expect(records).toEqual([{ x: 0, y: 0, c: 1 }, { x: 0, y: 0, c: 2 }]);
    expect(replay(buildTimelapse(game.log.bytes(), 8, 8))).toEqual(game.colors);
  });
});

describe('renderPng', () => {
  it('draws one pixel per cell with EMPTY as the background colour', () => {
    const colors = Uint8Array.from([EMPTY, 0, 31, 27]);
    const png = PNG.sync.read(renderPng(colors, 2, 2));
    expect([png.width, png.height]).toEqual([2, 2]);
    const px = (i: number) => [...png.data.subarray(i * 4, i * 4 + 4)];
    expect(px(0)).toEqual([...hexToRgb(EMPTY_COLOR), 255]);
    expect(px(1)).toEqual([...hexToRgb(PALETTE[0]!), 255]);
    expect(px(2)).toEqual([255, 255, 255, 255]);
    expect(px(3)).toEqual([0, 0, 0, 255]);
  });
});
