import bs58 from 'bs58';

/**
 * Sign-in message. The wallet signs it once (free, no transaction); the server
 * then issues a session token so pixels can be placed without a popup each time.
 * The server generates the exact text and verifies the signature over it.
 */
export function buildLoginMessage(p: { domain: string; wallet: string; nonce: string; issuedAt: string }): string {
  return [
    `${p.domain} veut que tu te connectes avec ton compte Solana :`,
    p.wallet,
    '',
    'Connexion à $PIXEL : pose des pixels sur la toile partagée.',
    'Cette signature est gratuite : elle ne crée aucune transaction et ne coûte aucun frais.',
    '',
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
  ].join('\n');
}

/** A Solana address is the base58 encoding of a 32-byte ed25519 public key. */
export function isValidWallet(wallet: unknown): wallet is string {
  if (typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 44) return false;
  try {
    return bs58.decode(wallet).length === 32;
  } catch {
    return false;
  }
}

/** "7xKX…9fQa" */
export function shortWallet(wallet: string): string {
  return wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet;
}

const FACTION_RE = /^[\p{L}\p{N}$ _.-]{2,16}$/u;

/** Faction names: 2–16 letters, digits, spaces, `$ _ . -`. Returns the trimmed name or null. */
export function normalizeFaction(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  return FACTION_RE.test(trimmed) ? trimmed : null;
}
