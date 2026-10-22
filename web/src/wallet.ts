import type { MeInfo } from '@pixel/shared';
import { SolanaSignMessage, type SolanaSignMessageFeature } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { api } from './api';
import { UserFacingError } from './messages';

/** Stored in localStorage so a reload keeps the player signed in. */
export interface Session {
  wallet: string;
  token: string;
  expiresAt: number;
}

export interface SignedIn {
  session: Session;
  me: MeInfo;
}

/** Something the player can pick in the wallet modal. */
export interface WalletChoice {
  id: string;
  name: string;
  icon: string | null;
  /** Shown under the name (dev wallet address). */
  detail?: string;
  signIn(): Promise<SignedIn>;
}

const SESSION_KEY = 'pixel.session';
const DEV_WALLET_KEY = 'pixel.devWallet';
/** Treat a session as expired a bit early so a placement never races the expiry. */
const EXPIRY_MARGIN_MS = 60_000;

const STANDARD_CONNECT = 'standard:connect';
const STANDARD_DISCONNECT = 'standard:disconnect';
interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}

/* ---------------- session ---------------- */

export function loadSession(now = Date.now()): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.wallet !== 'string' || typeof s.token !== 'string' || typeof s.expiresAt !== 'number') return null;
    if (s.expiresAt - EXPIRY_MARGIN_MS <= now) {
      clearSession();
      return null;
    }
    return s as Session;
  } catch {
    return null;
  }
}

function saveSession(s: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // Private mode: the session simply won't survive a reload.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing stored.
  }
}

/* ---------------- sign-in flow ---------------- */

/** nonce → wallet signs the server's exact message → verify → session. */
async function signIn(address: string, sign: (message: Uint8Array) => Promise<Uint8Array>): Promise<SignedIn> {
  const { nonce, message } = await api.nonce(address);
  let signature: Uint8Array;
  try {
    signature = await sign(new TextEncoder().encode(message));
  } catch (err) {
    throw toWalletError(err);
  }
  const res = await api.verify(address, nonce, bs58.encode(signature));
  const session: Session = { wallet: address, token: res.token, expiresAt: res.expiresAt };
  saveSession(session);
  return { session, me: res.me };
}

function toWalletError(err: unknown): UserFacingError {
  const e = err as { code?: number; message?: string } | null;
  if (e?.code === 4001 || /reject|denied|cancel|declin/i.test(e?.message ?? '')) {
    return new UserFacingError('Signature refusée dans le wallet.');
  }
  return new UserFacingError('Le wallet n’a pas pu signer le message.');
}

function isSolanaWallet(w: Wallet): boolean {
  return (
    STANDARD_CONNECT in w.features &&
    SolanaSignMessage in w.features &&
    w.chains.some((c) => c.startsWith('solana:'))
  );
}

let connectedWallet: Wallet | null = null;

function standardChoice(wallet: Wallet): WalletChoice {
  return {
    id: `std:${wallet.name}`,
    name: wallet.name,
    icon: wallet.icon,
    async signIn() {
      const connect = wallet.features[STANDARD_CONNECT] as ConnectFeature;
      const signer = (wallet.features as SolanaSignMessageFeature)[SolanaSignMessage];
      let accounts: readonly WalletAccount[];
      try {
        ({ accounts } = await connect.connect());
      } catch (err) {
        throw toWalletError(err);
      }
      const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0];
      if (!account) throw new UserFacingError('Aucun compte Solana autorisé dans ce wallet.');
      const result = await signIn(account.address, async (message) => {
        const [out] = await signer.signMessage({ account, message });
        if (!out) throw new Error('no signature');
        return out.signature;
      });
      connectedWallet = wallet;
      return result;
    },
  };
}

/* ---------------- dev wallet (mock mode) ---------------- */

function devKeypair(): nacl.SignKeyPair {
  try {
    const stored = localStorage.getItem(DEV_WALLET_KEY);
    if (stored) return nacl.sign.keyPair.fromSecretKey(bs58.decode(stored));
  } catch {
    // Corrupt or unavailable: make a new one.
  }
  const kp = nacl.sign.keyPair();
  try {
    localStorage.setItem(DEV_WALLET_KEY, bs58.encode(kp.secretKey));
  } catch {
    // Keypair lives for this page only.
  }
  return kp;
}

function devChoice(): WalletChoice {
  const kp = devKeypair();
  const address = bs58.encode(kp.publicKey);
  return {
    id: 'dev',
    name: 'Dev wallet (test)',
    icon: null,
    detail: address,
    signIn: () => signIn(address, async (message) => nacl.sign.detached(message, kp.secretKey)),
  };
}

/* ---------------- discovery ---------------- */

const registry = getWallets();

/** Wallets that can connect and sign a message, plus the dev wallet in mock mode. */
export function walletChoices(mock: boolean): WalletChoice[] {
  const choices = registry.get().filter(isSolanaWallet).map(standardChoice);
  if (mock) choices.push(devChoice());
  return choices;
}

/** Wallet extensions may register after the page loaded. */
export function onWalletsChanged(fn: () => void): () => void {
  const offRegister = registry.on('register', fn);
  const offUnregister = registry.on('unregister', fn);
  return () => {
    offRegister();
    offUnregister();
  };
}

export async function disconnectWallet(): Promise<void> {
  clearSession();
  const wallet = connectedWallet;
  connectedWallet = null;
  const feature = wallet?.features[STANDARD_DISCONNECT] as DisconnectFeature | undefined;
  try {
    await feature?.disconnect();
  } catch {
    // The session is already gone on our side; the wallet's own state does not matter.
  }
}

/* ---------------- mobile ---------------- */

export function isMobileDevice(): boolean {
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Links that reopen this page inside a wallet's in-app browser (where the wallet is injected). */
export function walletBrowserLinks(url = location.href): { name: string; href: string }[] {
  const target = encodeURIComponent(url);
  const ref = encodeURIComponent(location.origin);
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${target}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${target}?ref=${ref}` },
  ];
}
