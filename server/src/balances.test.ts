import { describe, expect, it, vi } from 'vitest';
import {
  BalanceCache, BalanceUnavailableError, MockBalances, RpcBalances, TokenBucket, sumTokenAccounts, type BalanceProvider,
} from './balances';
import { fakeClock, newWallet } from './test-helpers';

/** A provider whose answers the test controls. */
function scripted(): BalanceProvider & { value: number; failing: boolean; calls: number } {
  const p = {
    value: 0,
    failing: false,
    calls: 0,
    async fetchBalance() {
      p.calls++;
      if (p.failing) throw new Error('rpc down');
      return p.value;
    },
  };
  return p;
}

const wallet = newWallet().wallet;

describe('BalanceCache', () => {
  it('caches for the TTL then refreshes', async () => {
    const clock = fakeClock();
    const provider = scripted();
    const cache = new BalanceCache(provider, { ttlMs: 30_000, now: clock.now });
    provider.value = 10;
    expect(await cache.get(wallet)).toBe(10);
    provider.value = 20;
    clock.advance(29_999);
    expect(await cache.get(wallet)).toBe(10);
    clock.advance(1);
    expect(await cache.get(wallet)).toBe(20);
    expect(provider.calls).toBe(2);
  });

  it('uses a stale value for up to 5 minutes when the provider fails', async () => {
    const clock = fakeClock();
    const provider = scripted();
    const cache = new BalanceCache(provider, { ttlMs: 30_000, now: clock.now });
    provider.value = 50;
    await cache.get(wallet);
    provider.failing = true;
    clock.advance(4 * 60_000);
    expect(await cache.get(wallet)).toBe(50);
    clock.advance(60_000);
    await expect(cache.get(wallet)).rejects.toBeInstanceOf(BalanceUnavailableError);
  });

  it('fails without any cached value', async () => {
    const provider = scripted();
    provider.failing = true;
    const cache = new BalanceCache(provider, { ttlMs: 30_000, now: fakeClock().now });
    await expect(cache.get(wallet)).rejects.toBeInstanceOf(BalanceUnavailableError);
  });

  it('allows a forced refresh at most once per 10 s', async () => {
    const clock = fakeClock();
    const provider = scripted();
    const cache = new BalanceCache(provider, { ttlMs: 30_000, now: clock.now });
    await cache.get(wallet);
    provider.value = 1;
    expect(await cache.get(wallet, true)).toBe(1);
    provider.value = 2;
    clock.advance(5_000);
    expect(await cache.get(wallet, true)).toBe(1);
    clock.advance(5_000);
    expect(await cache.get(wallet, true)).toBe(2);
    expect(provider.calls).toBe(3);
  });

  it('shares one provider call between concurrent readers and reports changes', async () => {
    const provider = scripted();
    const onChange = vi.fn();
    const cache = new BalanceCache(provider, { ttlMs: 0, now: fakeClock().now, onChange });
    provider.value = 7;
    expect(await Promise.all([cache.get(wallet), cache.get(wallet)])).toEqual([7, 7]);
    expect(provider.calls).toBe(1);
    expect(onChange).not.toHaveBeenCalled();
    provider.value = 8;
    await cache.get(wallet);
    expect(onChange).toHaveBeenCalledWith(wallet);
  });
});

describe('BalanceCache protects the RPC', () => {
  it('does not ask again for 30 s after a failure, serving the stale value meanwhile', async () => {
    const clock = fakeClock();
    const provider = scripted();
    const cache = new BalanceCache(provider, { ttlMs: 30_000, now: clock.now });
    provider.value = 50;
    await cache.get(wallet);
    clock.advance(30_000);
    provider.failing = true;
    for (let i = 0; i < 5; i++) {
      expect(await cache.get(wallet)).toBe(50);
      clock.advance(2_000);
    }
    expect(provider.calls).toBe(2);
    clock.advance(20_000);
    provider.failing = false;
    provider.value = 60;
    expect(await cache.get(wallet)).toBe(60);
    expect(provider.calls).toBe(3);
  });

  it('answers unavailable at once during the backoff when nothing usable is cached', async () => {
    const clock = fakeClock();
    const provider = scripted();
    provider.failing = true;
    const cache = new BalanceCache(provider, { ttlMs: 30_000, now: clock.now });
    await expect(cache.get(wallet)).rejects.toBeInstanceOf(BalanceUnavailableError);
    await expect(cache.get(wallet, true)).rejects.toBeInstanceOf(BalanceUnavailableError);
    expect(provider.calls).toBe(1);
    clock.advance(30_000);
    await expect(cache.get(wallet)).rejects.toBeInstanceOf(BalanceUnavailableError);
    expect(provider.calls).toBe(2);
  });

  it('keeps provider calls within a global budget, serving stale values when it runs out', async () => {
    const clock = fakeClock();
    const provider = scripted();
    const cache = new BalanceCache(provider, { ttlMs: 30_000, now: clock.now, maxCallsPerSecond: 2 });
    const wallets = Array.from({ length: 6 }, () => newWallet().wallet);
    const settled = await Promise.allSettled(wallets.map((w) => cache.get(w)));
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected']);
    expect(provider.calls).toBe(4); // burst = twice the rate
    clock.advance(1_000);
    await cache.get(wallets[4]!);
    await cache.get(wallets[5]!);
    await expect(cache.get(newWallet().wallet)).rejects.toBeInstanceOf(BalanceUnavailableError);
    expect(provider.calls).toBe(6);
    // Out of budget, a wallet with a recent value keeps it instead of failing.
    clock.advance(31_000);
    for (const w of wallets) await cache.get(w);
    expect(provider.calls).toBe(10);
  });

  it('shares one call, and one token, between concurrent readers of a wallet', async () => {
    const provider = scripted();
    const cache = new BalanceCache(provider, { ttlMs: 0, now: fakeClock().now, maxCallsPerSecond: 1 });
    expect(await Promise.all([cache.get(wallet), cache.get(wallet), cache.get(wallet)])).toEqual([0, 0, 0]);
    expect(provider.calls).toBe(1);
  });
});

describe('TokenBucket', () => {
  it('starts full and refills at its rate, up to the burst', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 3, clock.now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    clock.advance(500);
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
    clock.advance(60_000);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
  });
});

describe('MockBalances', () => {
  it('defaults to 0 and round-trips through JSON', async () => {
    const mock = new MockBalances();
    expect(await mock.fetchBalance(wallet)).toBe(0);
    mock.set(wallet, 123);
    const copy = new MockBalances();
    copy.load(JSON.parse(JSON.stringify(mock)));
    expect(await copy.fetchBalance(wallet)).toBe(123);
  });
});

describe('RpcBalances', () => {
  const account = (ui: string) => ({ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: ui } } } } } });

  it('calls getTokenAccountsByOwner by mint and sums uiAmountString', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('getTokenAccountsByOwner');
      expect(body.params[0]).toBe(wallet);
      expect(body.params[1]).toEqual({ mint: 'MINT' });
      expect(body.params[2].encoding).toBe('jsonParsed');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ jsonrpc: '2.0', id: 1, result: { value: [account('1500.5'), account('0.5')] } });
    });
    const rpc = new RpcBalances('https://rpc.test', 'MINT', 5_000, fetchFn as unknown as typeof fetch);
    expect(await rpc.fetchBalance(wallet)).toBe(1501);
  });

  it('throws on RPC errors, HTTP errors and malformed results', async () => {
    const rpcWith = (res: Response) => new RpcBalances('u', 'M', 5_000, (async () => res) as unknown as typeof fetch);
    await expect(rpcWith(Response.json({ error: { message: 'boom' } })).fetchBalance(wallet)).rejects.toThrow(/boom/);
    await expect(rpcWith(new Response('', { status: 429 })).fetchBalance(wallet)).rejects.toThrow(/429/);
    expect(() => sumTokenAccounts({ value: [{}] })).toThrow();
    expect(sumTokenAccounts({ value: [] })).toBe(0);
  });
});
