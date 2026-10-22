import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS } from '@pixel/shared';
import { ConfigError, DEFAULT_THEMES, loadConfig } from './config';

const MINT = 'So11111111111111111111111111111111111111112';

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 8787, host: '0.0.0.0', mode: 'mock', adminToken: null, balanceTtlMs: 30_000,
      canvasWidth: 200, canvasHeight: 200, seasonMs: 7 * 86_400_000, breakMs: 3_600_000,
      chaosMs: 24 * 3_600_000, chaosFactor: 0.5, logoPosition: 'bottom-right', themes: DEFAULT_THEMES,
    });
    expect(c.token).toEqual({ symbol: '$PIXEL', mint: null, buyUrl: null });
    expect(c.tiers).toEqual(DEFAULT_TIERS);
  });

  it('requires TOKEN_MINT in live mode and derives the buy URL', () => {
    expect(() => loadConfig({ MODE: 'live' })).toThrow(ConfigError);
    const live = loadConfig({ MODE: 'live', TOKEN_MINT: MINT });
    expect(live.token.buyUrl).toBe(`https://pump.fun/coin/${MINT}`);
    expect(loadConfig({ TOKEN_MINT: MINT, BUY_URL: 'https://x.test' }).token.buyUrl).toBe('https://x.test');
    expect(() => loadConfig({ TOKEN_MINT: 'nope' })).toThrow(/TOKEN_MINT/);
  });

  it('validates sizes, numbers and enums', () => {
    expect(() => loadConfig({ CANVAS_WIDTH: '1001' })).toThrow(/CANVAS_WIDTH/);
    expect(() => loadConfig({ CANVAS_HEIGHT: '0' })).toThrow(/CANVAS_HEIGHT/);
    expect(() => loadConfig({ CANVAS_WIDTH: '12.5' })).toThrow(/CANVAS_WIDTH/);
    expect(() => loadConfig({ MODE: 'prod' })).toThrow(/MODE/);
    expect(() => loadConfig({ LOGO_POSITION: 'top' })).toThrow(/LOGO_POSITION/);
    expect(() => loadConfig({ CHAOS_FACTOR: '2' })).toThrow(/CHAOS_FACTOR/);
    expect(loadConfig({ SEASON_DAYS: '0.5' }).seasonMs).toBe(43_200_000);
  });

  it('validates TIERS with validateTiers', () => {
    const tiers = [{ id: 'a', label: 'A', minBalance: 1, cooldownMs: 10_000 }];
    expect(loadConfig({ TIERS: JSON.stringify(tiers) }).tiers).toEqual(tiers);
    expect(() => loadConfig({ TIERS: '[{"id":"a","label":"A","minBalance":1,"cooldownMs":120000}]' })).toThrow(/TIERS/);
    expect(() => loadConfig({ TIERS: 'not json' })).toThrow(/TIERS/);
  });

  it('parses themes and factions', () => {
    const c = loadConfig({ SEASON_THEMES: ' Un | Deux ||', FACTIONS: 'Les Bleus|Team $PIXEL' });
    expect(c.themes).toEqual(['Un', 'Deux']);
    expect(c.factions).toEqual(['Les Bleus', 'Team $PIXEL']);
    expect(() => loadConfig({ FACTIONS: '<script>' })).toThrow(/FACTIONS/);
  });
});
