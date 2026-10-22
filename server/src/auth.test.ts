import { describe, expect, it } from 'vitest';
import {
  MAX_NONCES_PER_WALLET, NONCE_TTL_MS, NonceStore, SESSION_TTL_MS, adminTokenMatches, bearerToken,
  createSessionToken, verifyLoginSignature, verifySessionToken,
} from './auth';
import { fakeClock, newWallet } from './test-helpers';

const SECRET = 'a-session-secret-of-reasonable-length';

/** Issue + consume + verify, the way /api/auth/verify does it. */
function login(store: NonceStore, wallet: string, nonce: string, signature: string): boolean {
  const message = store.consume(wallet, nonce);
  return message !== null && verifyLoginSignature(message, wallet, signature);
}

describe('login signature', () => {
  it('accepts a signature of the exact issued message by the wallet key', () => {
    const store = new NonceStore(fakeClock().now);
    const alice = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    expect(message).toContain(alice.wallet);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(true);
  });

  it('rejects a signature from another wallet', () => {
    const store = new NonceStore(fakeClock().now);
    const alice = newWallet();
    const mallory = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    expect(login(store, alice.wallet, nonce, mallory.sign(message))).toBe(false);
  });

  it('rejects a nonce used with the wrong wallet, and keeps it for its owner', () => {
    const store = new NonceStore(fakeClock().now);
    const alice = newWallet();
    const bob = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    expect(login(store, bob.wallet, nonce, bob.sign(message))).toBe(false);
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(true);
  });

  it('rejects a signature of a different message', () => {
    const store = new NonceStore(fakeClock().now);
    const alice = newWallet();
    const { nonce } = store.issue(alice.wallet, 'pixel.test');
    expect(login(store, alice.wallet, nonce, alice.sign('something else'))).toBe(false);
  });

  it('rejects a reused nonce', () => {
    const store = new NonceStore(fakeClock().now);
    const alice = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    const signature = alice.sign(message);
    expect(login(store, alice.wallet, nonce, signature)).toBe(true);
    expect(login(store, alice.wallet, nonce, signature)).toBe(false);
  });

  it('rejects an expired nonce', () => {
    const clock = fakeClock();
    const store = new NonceStore(clock.now);
    const alice = newWallet();
    const { nonce, message, expiresAt } = store.issue(alice.wallet, 'pixel.test');
    expect(expiresAt).toBe(clock.now() + NONCE_TTL_MS);
    clock.advance(NONCE_TTL_MS);
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(false);
  });

  it('keeps at most 5 outstanding nonces per wallet, evicting the oldest', () => {
    const store = new NonceStore(fakeClock().now);
    const alice = newWallet();
    const issued = Array.from({ length: MAX_NONCES_PER_WALLET + 1 }, () => store.issue(alice.wallet, 'pixel.test'));
    expect(store.size).toBe(MAX_NONCES_PER_WALLET);
    expect(store.consume(alice.wallet, issued[0]!.nonce)).toBeNull();
    expect(store.consume(alice.wallet, issued.at(-1)!.nonce)).toBe(issued.at(-1)!.message);
  });

  it('sweeps expired nonces', () => {
    const clock = fakeClock();
    const store = new NonceStore(clock.now);
    store.issue(newWallet().wallet, 'pixel.test');
    clock.advance(NONCE_TTL_MS + 1);
    store.sweep();
    expect(store.size).toBe(0);
  });

  it('survives garbage signatures and wallets', () => {
    expect(verifyLoginSignature('m', 'not-a-wallet', 'x')).toBe(false);
    expect(verifyLoginSignature('m', newWallet().wallet, '0OIl')).toBe(false);
    expect(verifyLoginSignature('m', newWallet().wallet, '')).toBe(false);
  });
});

describe('session tokens', () => {
  const wallet = newWallet().wallet;
  const t0 = Date.UTC(2026, 0, 1);

  it('round-trips and expires after 24 h', () => {
    const { token, expiresAt } = createSessionToken(wallet, SECRET, t0);
    expect(expiresAt).toBe(t0 + SESSION_TTL_MS);
    expect(verifySessionToken(token, SECRET, t0 + 1000)).toEqual({ wallet, expiresAt });
    expect(verifySessionToken(token, SECRET, expiresAt)).toBeNull();
  });

  it('rejects tampered payloads, signatures and secrets', () => {
    const { token } = createSessionToken(wallet, SECRET, t0);
    const [payload, mac] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ w: newWallet().wallet, exp: t0 + SESSION_TTL_MS })).toString('base64url');
    expect(verifySessionToken(`${forged}.${mac}`, SECRET, t0)).toBeNull();
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
    expect(verifySessionToken(`${payload}.${flipped}`, SECRET, t0)).toBeNull();
    expect(verifySessionToken(token, 'another-secret', t0)).toBeNull();
    expect(verifySessionToken(`${token}.x`, SECRET, t0)).toBeNull();
    expect(verifySessionToken('garbage', SECRET, t0)).toBeNull();
    expect(verifySessionToken(42, SECRET, t0)).toBeNull();
  });

  it('parses bearer headers', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('admin token', () => {
  it('compares in constant time and is disabled without a configured token', () => {
    expect(adminTokenMatches('dev', 'dev')).toBe(true);
    expect(adminTokenMatches('dev2', 'dev')).toBe(false);
    expect(adminTokenMatches('', 'dev')).toBe(false);
    expect(adminTokenMatches(undefined, 'dev')).toBe(false);
    expect(adminTokenMatches('dev', null)).toBe(false);
  });
});
