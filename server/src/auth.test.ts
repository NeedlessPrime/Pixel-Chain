import { describe, expect, it } from 'vitest';
import {
  NONCE_TTL_MS, NonceStore, SESSION_TTL_MS, adminTokenMatches, bearerToken,
  createSessionToken, verifyLoginSignature, verifySessionToken,
} from './auth';
import { fakeClock, newWallet } from './test-helpers';

const SECRET = 'a-session-secret-of-reasonable-length';

/** Open + verify + burn, the way /api/auth/verify does it. */
function login(store: NonceStore, wallet: string, nonce: string, signature: string): boolean {
  const issued = store.open(wallet, nonce);
  if (!issued || !verifyLoginSignature(issued.message, wallet, signature)) return false;
  store.burn(nonce, issued.expiresAt);
  return true;
}

const newStore = (now = fakeClock().now) => new NonceStore(SECRET, now);

describe('login signature', () => {
  it('accepts a signature of the exact issued message by the wallet key', () => {
    const store = newStore();
    const alice = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    expect(message.startsWith('pixel.test veut que tu te connectes')).toBe(true);
    expect(message).toContain(alice.wallet);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(store.open(alice.wallet, nonce)?.message).toBe(message);
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(true);
  });

  it('rejects a signature from another wallet, without burning the nonce', () => {
    const store = newStore();
    const alice = newWallet();
    const mallory = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    expect(login(store, alice.wallet, nonce, mallory.sign(message))).toBe(false);
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(true);
  });

  it('rejects a nonce used with the wrong wallet, and keeps it for its owner', () => {
    const store = newStore();
    const alice = newWallet();
    const bob = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    expect(login(store, bob.wallet, nonce, bob.sign(message))).toBe(false);
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(true);
  });

  it('rejects a signature of a different message', () => {
    const store = newStore();
    const alice = newWallet();
    const { nonce } = store.issue(alice.wallet, 'pixel.test');
    expect(login(store, alice.wallet, nonce, alice.sign('something else'))).toBe(false);
  });

  it('rejects a reused nonce until long after it expired', () => {
    const clock = fakeClock();
    const store = newStore(clock.now);
    const alice = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    const signature = alice.sign(message);
    expect(login(store, alice.wallet, nonce, signature)).toBe(true);
    expect(login(store, alice.wallet, nonce, signature)).toBe(false);
    clock.advance(NONCE_TTL_MS - 1);
    expect(login(store, alice.wallet, nonce, signature)).toBe(false);
  });

  it('rejects an expired nonce', () => {
    const clock = fakeClock();
    const store = newStore(clock.now);
    const alice = newWallet();
    const { nonce, message, expiresAt } = store.issue(alice.wallet, 'pixel.test');
    expect(expiresAt).toBe(clock.now() + NONCE_TTL_MS);
    clock.advance(NONCE_TTL_MS);
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(false);
  });

  it('keeps every issued nonce valid however many others are requested, storing none of them', () => {
    const store = newStore();
    const alice = newWallet();
    const others = [newWallet().wallet, newWallet().wallet];
    const first = store.issue(alice.wallet, 'pixel.test');
    for (let i = 0; i < 1000; i++) {
      store.issue(alice.wallet, 'pixel.test');
      store.issue(others[i % 2]!, 'pixel.test');
    }
    expect(store.size).toBe(0);
    expect(login(store, alice.wallet, first.nonce, alice.sign(first.message))).toBe(true);
  });

  it('rejects forged and tampered nonces', () => {
    const store = newStore();
    const alice = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    const [payload, mac] = nonce.split('.') as [string, string];
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const forge = (over: object) => `${Buffer.from(JSON.stringify({ ...data, ...over })).toString('base64url')}.${mac}`;
    for (const forged of [forge({ d: 'evil.test' }), forge({ iat: data.iat + 60_000 }), forge({ r: 'x' })]) {
      expect(store.open(alice.wallet, forged)).toBeNull();
    }
    expect(new NonceStore('another-secret-of-reasonable-length', fakeClock().now).open(alice.wallet, nonce)).toBeNull();
    for (const garbage of ['', '.', 'abc', `${nonce}.x`, `${payload}.`, `${payload}.${mac}A`]) {
      expect(store.open(alice.wallet, garbage)).toBeNull();
    }
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(true);
  });

  it('forgets used nonces once they expire', () => {
    const clock = fakeClock();
    const store = newStore(clock.now);
    const alice = newWallet();
    const { nonce, message } = store.issue(alice.wallet, 'pixel.test');
    expect(login(store, alice.wallet, nonce, alice.sign(message))).toBe(true);
    expect(store.size).toBe(1);
    clock.advance(NONCE_TTL_MS);
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

  it('accepts only the canonical spelling of the MAC', () => {
    const { token } = createSessionToken(wallet, SECRET, t0);
    const [payload, mac] = token.split('.') as [string, string];
    // The last base64url character carries 2 padding bits: flipping one keeps the decoded bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respelled = mac.slice(0, -1) + alphabet[alphabet.indexOf(mac.at(-1)!) ^ 1];
    expect(Buffer.from(respelled, 'base64url')).toEqual(Buffer.from(mac, 'base64url'));
    expect(verifySessionToken(`${payload}.${respelled}`, SECRET, t0)).toBeNull();
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
