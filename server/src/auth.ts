import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { buildLoginMessage, isValidWallet, type NonceResponse } from '@pixel/shared';

export const NONCE_TTL_MS = 5 * 60_000;
/** Longest nonce /api/auth/verify accepts (the payload carries the domain, up to 253 characters). */
export const MAX_NONCE_LENGTH = 1024;
export const SESSION_TTL_MS = 24 * 3_600_000;

interface NoncePayload {
  /** wallet */
  w: string;
  /** domain written in the message */
  d: string;
  /** issued at, ms epoch */
  iat: number;
  /** random */
  r: string;
}

function parseNoncePayload(payload: string): NoncePayload | null {
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<NoncePayload>;
    const ok = typeof p.w === 'string' && typeof p.d === 'string' && Number.isSafeInteger(p.iat) && typeof p.r === 'string';
    return ok ? (p as NoncePayload) : null;
  } catch {
    return null;
  }
}

/**
 * Login nonces, stateless: `base64url(JSON{w, d, iat, r}) + "." + base64url(HMAC-SHA256)`,
 * so the exact message can be rebuilt from the nonce alone. Nothing is kept per
 * issued nonce, so requesting nonces (for any wallet) cannot evict anyone's.
 * Nonces that served a login are remembered until they expire, against replays.
 */
export class NonceStore {
  private readonly key: Buffer;
  /** nonce -> expiresAt, roughly in expiry order */
  private readonly used = new Map<string, number>();

  constructor(sessionSecret: string, private readonly now: () => number) {
    // A key of its own, so a nonce can never pass for a session token or the reverse.
    this.key = createHmac('sha256', sessionSecret).update('pixel:login-nonce:v1').digest();
  }

  issue(wallet: string, domain: string): NonceResponse {
    const iat = this.now();
    const data: NoncePayload = { w: wallet, d: domain, iat, r: randomBytes(16).toString('base64url') };
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const nonce = `${payload}.${this.mac(payload)}`;
    return { nonce, message: loginMessage(data, nonce), expiresAt: iat + NONCE_TTL_MS };
  }

  /** The message issued with this nonce; null if forged, expired, already used or issued to another wallet. */
  open(wallet: string, nonce: string): { message: string; expiresAt: number } | null {
    const [payload, mac, extra] = nonce.split('.');
    if (!payload || !mac || extra !== undefined) return null;
    const expected = Buffer.from(this.mac(payload));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const data = parseNoncePayload(payload);
    if (!data || data.w !== wallet) return null;
    const expiresAt = data.iat + NONCE_TTL_MS;
    if (expiresAt <= this.now() || this.used.has(nonce)) return null;
    return { message: loginMessage(data, nonce), expiresAt };
  }

  /** Remembers a nonce that served a login until it expires. */
  burn(nonce: string, expiresAt: number): void {
    const now = this.now();
    for (const [old, until] of this.used) {
      if (until > now) break;
      this.used.delete(old);
    }
    this.used.set(nonce, expiresAt);
  }

  /** Forgets every expired used nonce (called periodically). */
  sweep(): void {
    const now = this.now();
    for (const [nonce, until] of this.used) {
      if (until <= now) this.used.delete(nonce);
    }
  }

  /** Used nonces still remembered. */
  get size(): number {
    return this.used.size;
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }
}

function loginMessage(data: NoncePayload, nonce: string): string {
  return buildLoginMessage({ domain: data.d, wallet: data.w, nonce, issuedAt: new Date(data.iat).toISOString() });
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
  // Compared as text: decoding would also accept other spellings of the same MAC (base64 padding bits).
  const expected = Buffer.from(hmac(secret, payload).toString('base64url'));
  const given = Buffer.from(mac);
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
