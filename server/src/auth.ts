import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { buildLoginMessage, isValidWallet, type NonceResponse } from '@pixel/shared';

export const NONCE_TTL_MS = 5 * 60_000;
export const MAX_NONCES_PER_WALLET = 5;
/** Global bound so nonce requests from many IPs cannot exhaust memory. */
const MAX_PENDING_NONCES = 50_000;
export const SESSION_TTL_MS = 24 * 3_600_000;

interface PendingNonce {
  wallet: string;
  message: string;
  expiresAt: number;
}

/** Login nonces: single use, short-lived, a few per wallet. */
export class NonceStore {
  private readonly byNonce = new Map<string, PendingNonce>();
  private readonly byWallet = new Map<string, string[]>();

  constructor(private readonly now: () => number) {}

  issue(wallet: string, domain: string): NonceResponse {
    const now = this.now();
    this.dropExpired(wallet, now);
    // Evict the oldest rather than refuse, so spamming nonces for someone else's wallet cannot lock them out.
    while (this.pendingFor(wallet).length >= MAX_NONCES_PER_WALLET) this.forget(this.pendingFor(wallet)[0]!);
    if (this.byNonce.size >= MAX_PENDING_NONCES) this.forget(this.byNonce.keys().next().value!);

    const nonce = randomBytes(16).toString('hex');
    const message = buildLoginMessage({ domain, wallet, nonce, issuedAt: new Date(now).toISOString() });
    const expiresAt = now + NONCE_TTL_MS;
    this.byNonce.set(nonce, { wallet, message, expiresAt });
    this.byWallet.set(wallet, [...this.pendingFor(wallet), nonce]);
    return { nonce, message, expiresAt };
  }

  /** Returns the message issued with this nonce and burns it; null if unknown, expired or issued to another wallet. */
  consume(wallet: string, nonce: string): string | null {
    const entry = this.byNonce.get(nonce);
    if (!entry || entry.wallet !== wallet) return null;
    this.forget(nonce);
    return entry.expiresAt > this.now() ? entry.message : null;
  }

  /** Drops every expired nonce (called periodically). */
  sweep(): void {
    const now = this.now();
    for (const [nonce, entry] of this.byNonce) {
      if (entry.expiresAt <= now) this.forget(nonce);
    }
  }

  get size(): number {
    return this.byNonce.size;
  }

  private pendingFor(wallet: string): string[] {
    return this.byWallet.get(wallet) ?? [];
  }

  private dropExpired(wallet: string, now: number): void {
    for (const nonce of this.pendingFor(wallet)) {
      if (this.byNonce.get(nonce)!.expiresAt <= now) this.forget(nonce);
    }
  }

  private forget(nonce: string): void {
    const entry = this.byNonce.get(nonce);
    if (!entry) return;
    this.byNonce.delete(nonce);
    const rest = (this.byWallet.get(entry.wallet) ?? []).filter((n) => n !== nonce);
    if (rest.length) this.byWallet.set(entry.wallet, rest);
    else this.byWallet.delete(entry.wallet);
  }
}

/** Checks a base58 ed25519 signature of `message` (UTF-8) by the wallet's public key. */
export function verifyLoginSignature(message: string, wallet: string, signature: string): boolean {
  if (!isValidWallet(wallet)) return false;
  try {
    const sig = bs58.decode(signature);
    if (sig.length !== nacl.sign.signatureLength) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, bs58.decode(wallet));
  } catch {
    return false;
  }
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export interface Session {
  wallet: string;
  /** ms epoch */
  expiresAt: number;
}

/** `base64url(JSON{w, exp}) + "." + base64url(HMAC-SHA256(payload))` */
export function createSessionToken(wallet: string, secret: string, now: number): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ w: wallet, exp: expiresAt })).toString('base64url');
  return { token: `${payload}.${hmac(secret, payload).toString('base64url')}`, expiresAt };
}

/** The session carried by a token, or null if malformed, tampered with or expired. */
export function verifySessionToken(token: unknown, secret: string, now: number): Session | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = hmac(secret, payload);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { w?: unknown; exp?: unknown };
    if (!isValidWallet(data.w) || typeof data.exp !== 'number' || data.exp <= now) return null;
    return { wallet: data.w, expiresAt: data.exp };
  } catch {
    return null;
  }
}

/** `Authorization: Bearer <token>` -> token */
export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1]! : null;
}

/** Constant-time comparison (hashing first makes the lengths equal). */
export function adminTokenMatches(given: unknown, expected: string | null): boolean {
  if (!expected || typeof given !== 'string' || !given) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
