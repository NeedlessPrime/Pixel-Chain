/**
 * Holding tiers: the more $PIXEL a wallet holds, the shorter its cooldown
 * between two pixels. The slowest tier is 1 pixel per minute, so every holder
 * can play. Wallets below the lowest tier must buy before they can paint.
 *
 * A tier with minBalance 0 would let wallets that hold nothing play too.
 */
export interface Tier {
  id: string;
  /** Shown in the UI (French). */
  label: string;
  /** Minimum $PIXEL held (UI amount, decimals already applied). */
  minBalance: number;
  /** Delay between two pixels, before the chaos bonus. */
  cooldownMs: number;
}

/** Placeholders to tune at launch (1B supply: 1M tokens = 0.1 %). */
export const DEFAULT_TIERS: readonly Tier[] = [
  { id: 'whale', label: 'Baleine', minBalance: 1_000_000, cooldownMs: 5_000 },
  { id: 'holder', label: 'Holder', minBalance: 100_000, cooldownMs: 30_000 },
  { id: 'player', label: 'Joueur', minBalance: 10_000, cooldownMs: 60_000 },
];

/** No tier may be slower than this: "une minute max". */
export const MAX_COOLDOWN_MS = 60_000;
/** Floor so the chaos factor can never make placement instant. */
export const MIN_COOLDOWN_MS = 1_000;

/** Best tier the balance qualifies for, or null if the wallet must buy first. */
export function tierForBalance(balance: number, tiers: readonly Tier[]): Tier | null {
  let best: Tier | null = null;
  for (const t of tiers) {
    if (balance >= t.minBalance && (!best || t.minBalance > best.minBalance)) best = t;
  }
  return best;
}

/** Cooldown actually applied, with the end-of-season chaos factor (e.g. 0.5 = twice as fast). */
export function effectiveCooldownMs(tier: Tier, chaosActive: boolean, chaosFactor: number): number {
  const base = Math.min(tier.cooldownMs, MAX_COOLDOWN_MS);
  const ms = chaosActive ? base * chaosFactor : base;
  return Math.max(MIN_COOLDOWN_MS, Math.round(ms));
}

/** Throws if a tier list is unusable (used when TIERS comes from the environment). */
export function validateTiers(tiers: unknown): Tier[] {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Error('tiers must be a non-empty array');
  return tiers.map((t, i) => {
    const ok =
      t && typeof t.id === 'string' && typeof t.label === 'string' &&
      typeof t.minBalance === 'number' && t.minBalance >= 0 &&
      typeof t.cooldownMs === 'number' && t.cooldownMs >= MIN_COOLDOWN_MS && t.cooldownMs <= MAX_COOLDOWN_MS;
    if (!ok) throw new Error(`invalid tier at index ${i}`);
    return { id: t.id, label: t.label, minBalance: t.minBalance, cooldownMs: t.cooldownMs };
  });
}
