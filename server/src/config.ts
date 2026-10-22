import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIERS, MAX_CANVAS_SIZE, isValidWallet, normalizeFaction, validateTiers, type Tier,
} from '@pixel/shared';

export type Mode = 'mock' | 'live';
export type LogoPosition = 'bottom-right' | 'center';

export interface ServerConfig {
  port: number;
  host: string;
  mode: Mode;
  dataDir: string;
  /** Domain written in the login message; null = use the request Host header. */
  publicDomain: string | null;
  /** null = random secret persisted in DATA_DIR/secret. */
  sessionSecret: string | null;
  /** null = admin API disabled. */
  adminToken: string | null;
  /**
   * Whom to trust for X-Forwarded-* (client IP for rate limits, Host for the login message):
   * false = nobody, a number = that many proxy hops in front, a string = comma-separated proxy IPs/CIDRs.
   */
  trustProxy: false | number | string;
  token: { symbol: string; mint: string | null; buyUrl: string | null };
  rpcUrl: string;
  /** Global cap on balance RPC calls per second (bursts up to twice this). */
  rpcMaxRps: number;
  balanceTtlMs: number;
  tiers: Tier[];
  canvasWidth: number;
  canvasHeight: number;
  seasonMs: number;
  breakMs: number;
  chaosMs: number;
  chaosFactor: number;
  themes: string[];
  factions: string[];
  logoPath: string | null;
  logoPosition: LogoPosition;
  webDist: string;
}

/** The server package directory: defaults are anchored here so the cwd does not matter. */
export const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_THEMES = [
  'Les mèmes de Solana',
  'Pixel libre',
  'Rétro gaming',
  'Drapeaux et blasons',
  "L'espace",
  'Animaux',
];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function num(env: Env, key: string, def: number, opts: { min: number; max: number; integer?: boolean }): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  const ok = Number.isFinite(n) && n >= opts.min && n <= opts.max && (!opts.integer || Number.isInteger(n));
  if (!ok) {
    const kind = opts.integer ? 'an integer' : 'a number';
    throw new ConfigError(`${key} must be ${kind} between ${opts.min} and ${opts.max} (got "${raw}")`);
  }
  return n;
}

function oneOf<T extends string>(env: Env, key: string, values: readonly T[], def: T): T {
  const raw = str(env, key) ?? def;
  if (!values.includes(raw as T)) throw new ConfigError(`${key} must be one of ${values.join(', ')} (got "${raw}")`);
  return raw as T;
}

function list(env: Env, key: string): string[] | undefined {
  const raw = str(env, key);
  return raw?.split('|').map((s) => s.trim()).filter(Boolean);
}

function parseTiers(env: Env): Tier[] {
  const raw = str(env, 'TIERS');
  if (!raw) return DEFAULT_TIERS.map((t) => ({ ...t }));
  try {
    return validateTiers(JSON.parse(raw));
  } catch (err) {
    throw new ConfigError(`TIERS is invalid: ${(err as Error).message}`);
  }
}

function parseFactions(env: Env): string[] {
  return (list(env, 'FACTIONS') ?? []).map((name) => {
    const faction = normalizeFaction(name);
    if (!faction) throw new ConfigError(`FACTIONS contains an invalid name: "${name}"`);
    return faction;
  });
}

function parseLogoPath(env: Env): string | null {
  const raw = str(env, 'LOGO_PATH');
  if (raw) {
    const resolved = path.resolve(raw);
    if (!existsSync(resolved)) throw new ConfigError(`LOGO_PATH does not exist: ${resolved}`);
    return resolved;
  }
  const fallback = path.join(SERVER_ROOT, 'assets', 'logo.png');
  return existsSync(fallback) ? fallback : null;
}

/** Address presets understood by proxy-addr. */
const PROXY_PRESETS = ['loopback', 'linklocal', 'uniquelocal'];

function isIpOrCidr(value: string): boolean {
  const [ip = '', bits, extra] = value.split('/');
  const version = isIP(ip);
  if (!version || extra !== undefined) return false;
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (version === 4 ? 32 : 128));
}

/** Never `true`: trusting every hop would let any client pick its own IP with X-Forwarded-For. */
function parseTrustProxy(env: Env): false | number | string {
  const raw = str(env, 'TRUST_PROXY');
  if (raw === undefined || raw.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw) || false;
  const entries = raw.split(',').map((s) => s.trim());
  if (!entries.every((e) => PROXY_PRESETS.includes(e) || isIpOrCidr(e))) {
    throw new ConfigError(
      `TRUST_PROXY must be the number of proxies in front of the server (usually 1) or a comma-separated list of proxy IPs/CIDRs (got "${raw}")`,
    );
  }
  return entries.join(',');
}

function parseAdminToken(env: Env): string | null {
  const token = str(env, 'ADMIN_TOKEN');
  if (token === undefined) return null;
  if (token === 'change-me' || token.length < 16) {
    throw new ConfigError('ADMIN_TOKEN must be a long random string (16+ characters, e.g. `openssl rand -hex 24`), or empty to disable /admin');
  }
  return token;
}

function parseSessionSecret(env: Env): string | null {
  const secret = str(env, 'SESSION_SECRET');
  if (secret !== undefined && secret.length < 32) {
    throw new ConfigError('SESSION_SECRET must be at least 32 characters (e.g. `openssl rand -hex 32`), or unset to keep a random one in DATA_DIR/secret');
  }
  return secret ?? null;
}

function parseMint(env: Env, mode: Mode): string | null {
  const mint = str(env, 'TOKEN_MINT') ?? null;
  if (mint && !isValidWallet(mint)) throw new ConfigError('TOKEN_MINT is not a valid Solana address');
  if (mode === 'live' && !mint) throw new ConfigError('MODE=live requires TOKEN_MINT');
  return mint;
}

/** The buy button is a link players click: only https pages, never javascript: or other schemes. */
function parseBuyUrl(env: Env, mint: string | null): string | null {
  const raw = str(env, 'BUY_URL');
  if (!raw) return mint ? `https://pump.fun/coin/${mint}` : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('BUY_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new ConfigError('BUY_URL must be an https:// URL');
  return raw;
}

/** Reads and validates the environment. Throws ConfigError with a readable message. */
export function loadConfig(env: Env = process.env): ServerConfig {
  // A mint means real balances, unless MODE=mock is asked for explicitly.
  const mode = oneOf(env, 'MODE', ['mock', 'live'] as const, str(env, 'TOKEN_MINT') ? 'live' : 'mock');
  const mint = parseMint(env, mode);
  const sizeOpts = { min: 1, max: MAX_CANVAS_SIZE, integer: true };
  const themes = list(env, 'SEASON_THEMES') ?? DEFAULT_THEMES;
  if (themes.length === 0) throw new ConfigError('SEASON_THEMES must contain at least one theme');

  return {
    port: num(env, 'PORT', 8787, { min: 0, max: 65535, integer: true }),
    host: str(env, 'HOST') ?? '0.0.0.0',
    mode,
    dataDir: path.resolve(str(env, 'DATA_DIR') ?? path.join(SERVER_ROOT, 'data')),
    publicDomain: str(env, 'PUBLIC_DOMAIN') ?? null,
    sessionSecret: parseSessionSecret(env),
    adminToken: parseAdminToken(env),
    trustProxy: parseTrustProxy(env),
    token: {
      symbol: str(env, 'TOKEN_SYMBOL') ?? '$PIXEL',
      mint,
      buyUrl: parseBuyUrl(env, mint),
    },
    rpcUrl: str(env, 'SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com',
    rpcMaxRps: num(env, 'RPC_MAX_RPS', 20, { min: 1, max: 10_000 }),
    balanceTtlMs: num(env, 'BALANCE_TTL_MS', 30_000, { min: 0, max: DAY_MS, integer: true }),
    tiers: parseTiers(env),
    canvasWidth: num(env, 'CANVAS_WIDTH', 200, sizeOpts),
    canvasHeight: num(env, 'CANVAS_HEIGHT', 200, sizeOpts),
    seasonMs: Math.round(num(env, 'SEASON_DAYS', 7, { min: 0.0001, max: 365 }) * DAY_MS),
    breakMs: Math.round(num(env, 'SEASON_BREAK_MINUTES', 60, { min: 0, max: 30 * 24 * 60 }) * MINUTE_MS),
    chaosMs: Math.round(num(env, 'CHAOS_HOURS', 24, { min: 0, max: 365 * 24 }) * HOUR_MS),
    chaosFactor: num(env, 'CHAOS_FACTOR', 0.5, { min: 0.01, max: 1 }),
    themes,
    factions: parseFactions(env),
    logoPath: parseLogoPath(env),
    logoPosition: oneOf(env, 'LOGO_POSITION', ['bottom-right', 'center'] as const, 'bottom-right'),
    webDist: path.resolve(str(env, 'WEB_DIST') ?? path.join(SERVER_ROOT, '..', 'web', 'dist')),
  };
}
