/** Where token balances come from: fake (mock mode) or Solana JSON-RPC (live mode). */
export interface BalanceProvider {
  fetchBalance(wallet: string): Promise<number>;
}

export const MAX_MOCK_BALANCE = 1e15;

/** In-memory fake balances, set through /api/dev/balance and persisted with the state. */
export class MockBalances implements BalanceProvider {
  private readonly balances = new Map<string, number>();

  async fetchBalance(wallet: string): Promise<number> {
    return this.balances.get(wallet) ?? 0;
  }

  set(wallet: string, balance: number): void {
    this.balances.set(wallet, balance);
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.balances);
  }

  load(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    for (const [wallet, balance] of Object.entries(data)) {
      if (typeof balance === 'number' && Number.isFinite(balance) && balance >= 0) this.balances.set(wallet, balance);
    }
  }
}

/** Sums `uiAmountString` over a jsonParsed `getTokenAccountsByOwner` result (SPL Token and Token-2022). */
export function sumTokenAccounts(result: unknown): number {
  const accounts = (result as { value?: unknown } | null)?.value;
  if (!Array.isArray(accounts)) throw new Error('unexpected RPC result shape');
  let total = 0;
  for (const acc of accounts) {
    const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
    const n = Number(amount);
    if (typeof amount !== 'string' || !Number.isFinite(n)) throw new Error('unexpected token account shape');
    total += n;
  }
  return total;
}

export class RpcBalances implements BalanceProvider {
  constructor(
    private readonly rpcUrl: string,
    private readonly mint: string,
    private readonly timeoutMs = 5_000,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async fetchBalance(wallet: string): Promise<number> {
    const res = await this.fetchFn(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [wallet, { mint: this.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`);
    return sumTokenAccounts(body.result);
  }
}

export class BalanceUnavailableError extends Error {}

/** Refills `ratePerSecond` tokens per second, up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(private readonly ratePerSecond: number, private readonly burst: number, private readonly now: () => number) {
    this.tokens = burst;
    this.updatedAt = now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.updatedAt) / 1000) * this.ratePerSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

interface CacheEntry {
  balance: number;
  fetchedAt: number;
}

export interface BalanceCacheOptions {
  ttlMs: number;
  now: () => number;
  /** How long a stale value may still be used when the RPC fails. */
  staleMaxMs?: number;
  /** Minimum delay between two forced refreshes of the same wallet. */
  forceIntervalMs?: number;
  /** After a failed read, how long the provider is not asked again for that wallet. */
  failureBackoffMs?: number;
  /** Global cap on provider calls (bursts up to twice this); unset = unlimited (mock balances). */
  maxCallsPerSecond?: number;
  /** Called when a refresh returns a different balance than the cached one. */
  onChange?: (wallet: string) => void;
}

/**
 * Per-wallet balance cache with TTL, stale-on-error and rate-limited forced
 * refreshes. Provider calls are bounded per wallet (one at a time, none for a
 * while after a failure) and globally (token bucket), so neither a flaky RPC
 * nor many sessions can make the server hammer it.
 */
export class BalanceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly lastForced = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<number>>();
  private readonly staleMaxMs: number;
  private readonly forceIntervalMs: number;
  private readonly failureBackoffMs: number;
  private readonly budget: TokenBucket | null;

  constructor(private readonly provider: BalanceProvider, private readonly opts: BalanceCacheOptions) {
    this.staleMaxMs = opts.staleMaxMs ?? 5 * 60_000;
    this.forceIntervalMs = opts.forceIntervalMs ?? 10_000;
    this.failureBackoffMs = opts.failureBackoffMs ?? 30_000;
    const rate = opts.maxCallsPerSecond;
    this.budget = rate ? new TokenBucket(rate, Math.max(1, 2 * rate), opts.now) : null;
  }

  /** Last known balance, without any I/O. */
  peek(wallet: string): CacheEntry | undefined {
    return this.entries.get(wallet);
  }

  isFresh(wallet: string): boolean {
    const entry = this.entries.get(wallet);
    return !!entry && this.opts.now() - entry.fetchedAt < this.opts.ttlMs;
  }

  /**
   * Balance to use now: the cached value while fresh, otherwise a refreshed one.
   * If the provider fails (or is not asked: backoff, budget), a value younger
   * than `staleMaxMs` is used instead.
   * @throws BalanceUnavailableError when no usable value exists
   */
  async get(wallet: string, force = false): Promise<number> {
    if (this.isFresh(wallet) && !this.claimForcedRefresh(wallet, force)) return this.entries.get(wallet)!.balance;
    try {
      return await this.refresh(wallet);
    } catch (err) {
      const stale = this.entries.get(wallet);
      if (stale && this.opts.now() - stale.fetchedAt < this.staleMaxMs) return stale.balance;
      throw new BalanceUnavailableError((err as Error).message);
    }
  }

  /** Sets a known value (mock mode) without asking the provider. The caller notifies. */
  set(wallet: string, balance: number): void {
    this.entries.set(wallet, { balance, fetchedAt: this.opts.now() });
  }

  /** Forgets entries nobody used for a long time. */
  prune(maxAgeMs = 3_600_000): void {
    const cutoff = this.opts.now() - maxAgeMs;
    for (const [wallet, entry] of this.entries) {
      if (entry.fetchedAt < cutoff) this.entries.delete(wallet);
    }
    for (const [wallet, at] of this.lastForced) {
      if (at < cutoff) this.lastForced.delete(wallet);
    }
    for (const [wallet, at] of this.failedAt) {
      if (this.opts.now() - at >= this.failureBackoffMs) this.failedAt.delete(wallet);
    }
  }

  /** True if a forced refresh was asked for and is allowed now (at most once per forceIntervalMs). */
  private claimForcedRefresh(wallet: string, force: boolean): boolean {
    if (!force) return false;
    const now = this.opts.now();
    const last = this.lastForced.get(wallet);
    if (last !== undefined && now - last < this.forceIntervalMs) return false;
    this.lastForced.set(wallet, now);
    return true;
  }

  /** One provider call per wallet at a time (concurrent callers share it), within the backoff and the budget. */
  private refresh(wallet: string): Promise<number> {
    const pending = this.inflight.get(wallet);
    if (pending) return pending;
    const failedAt = this.failedAt.get(wallet);
    if (failedAt !== undefined && this.opts.now() - failedAt < this.failureBackoffMs) {
      return Promise.reject(new Error('the last balance read failed, retrying later'));
    }
    if (this.budget && !this.budget.take()) return Promise.reject(new Error('too many balance reads right now'));
    const call = this.provider
      .fetchBalance(wallet)
      .then(
        (balance) => {
          this.failedAt.delete(wallet);
          this.store(wallet, balance);
          return balance;
        },
        (err: unknown) => {
          this.failedAt.set(wallet, this.opts.now());
          throw err;
        },
      )
      .finally(() => this.inflight.delete(wallet));
    this.inflight.set(wallet, call);
    return call;
  }

  private store(wallet: string, balance: number): void {
    const previous = this.entries.get(wallet)?.balance;
    this.entries.set(wallet, { balance, fetchedAt: this.opts.now() });
    if (previous !== undefined && previous !== balance) this.opts.onChange?.(wallet);
  }
}
