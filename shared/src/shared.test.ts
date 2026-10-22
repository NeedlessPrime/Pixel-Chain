import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIERS, EMPTY, MAX_COOLDOWN_MS, decodeTimelapse, effectiveCooldownMs, encodeTimelapse,
  isValidWallet, nearestPaletteIndex, normalizeFaction, tierForBalance, validateTiers,
} from './index';

describe('tiers', () => {
  it('picks the best tier the balance qualifies for', () => {
    expect(tierForBalance(0, DEFAULT_TIERS)).toBeNull();
    expect(tierForBalance(9_999, DEFAULT_TIERS)).toBeNull();
    expect(tierForBalance(10_000, DEFAULT_TIERS)?.cooldownMs).toBe(60_000);
    expect(tierForBalance(150_000, DEFAULT_TIERS)?.cooldownMs).toBe(30_000);
    expect(tierForBalance(5_000_000, DEFAULT_TIERS)?.cooldownMs).toBe(5_000);
  });

  it('never exceeds one minute and applies chaos', () => {
    for (const t of DEFAULT_TIERS) expect(effectiveCooldownMs(t, false, 0.5)).toBeLessThanOrEqual(MAX_COOLDOWN_MS);
    expect(effectiveCooldownMs(DEFAULT_TIERS[2]!, true, 0.5)).toBe(30_000);
    expect(effectiveCooldownMs(DEFAULT_TIERS[0]!, true, 0.01)).toBe(1_000);
  });

  it('rejects tiers slower than one minute', () => {
    expect(() => validateTiers([{ id: 'x', label: 'x', minBalance: 1, cooldownMs: 120_000 }])).toThrow();
  });
});

describe('helpers', () => {
  it('validates wallets', () => {
    expect(isValidWallet('11111111111111111111111111111111')).toBe(true);
    expect(isValidWallet('not-a-wallet')).toBe(false);
  });

  it('normalizes factions', () => {
    expect(normalizeFaction('  Team   $PIXEL ')).toBe('Team $PIXEL');
    expect(normalizeFaction('x')).toBeNull();
    expect(normalizeFaction('<script>')).toBeNull();
  });

  it('maps colours to the palette', () => {
    expect(nearestPaletteIndex(255, 255, 255)).toBe(31);
    expect(nearestPaletteIndex(0, 0, 0)).toBe(27);
  });
});

describe('timelapse', () => {
  it('round-trips', () => {
    const recs = [{ x: 1, y: 2, c: 3 }, { x: 999, y: 0, c: EMPTY }];
    const d = decodeTimelapse(encodeTimelapse(1000, 500, recs));
    expect([d.width, d.height, d.count]).toEqual([1000, 500, 2]);
    expect([d.xs[1], d.ys[1], d.cs[1]]).toEqual([999, 0, EMPTY]);
  });
});
