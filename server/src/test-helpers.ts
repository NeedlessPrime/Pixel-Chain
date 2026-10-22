/* Shared by the *.test.ts files. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { createApp, type AppOptions, type PixelApp } from './app';
import { loadConfig, type ServerConfig } from './config';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'pixel-test-'));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface FakeClock {
  now: () => number;
  advance(ms: number): void;
  set(t: number): void;
}

export function fakeClock(start = Date.UTC(2026, 0, 5, 12)): FakeClock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms), set: (v) => void (t = v) };
}

/** A mock-mode config on a small canvas, with the built-in logo and no web build. */
export function testConfig(dataDir: string, env: Record<string, string> = {}): ServerConfig {
  const config = loadConfig({
    MODE: 'mock',
    DATA_DIR: dataDir,
    CANVAS_WIDTH: '64',
    CANVAS_HEIGHT: '48',
    SESSION_SECRET: 'test-secret-test-secret-test-secret',
    ADMIN_TOKEN: 'admin-test-token',
    WEB_DIST: path.join(dataDir, 'no-web-build'),
    HOST: '127.0.0.1',
    PORT: '0',
    ...env,
  });
  return { ...config, logoPath: null };
}

export interface TestApp extends PixelApp {
  dir: string;
  clock: FakeClock;
  /** Closes the app and deletes its data directory. */
  dispose(): Promise<void>;
}

/** An app on a temp DATA_DIR with a fake clock and no timers (tests call `tick()`). */
export async function startTestApp(
  opts: { dir?: string; clock?: FakeClock; env?: Record<string, string> } & Partial<AppOptions> = {},
): Promise<TestApp> {
  const dir = opts.dir ?? (await tempDir());
  const clock = opts.clock ?? fakeClock();
  const app = await createApp({ timers: false, ...opts, config: opts.config ?? testConfig(dir, opts.env), now: clock.now });
  return {
    ...app,
    dir,
    clock,
    async dispose() {
      await app.close();
      await removeDir(dir);
    },
  };
}

export interface TestWallet {
  wallet: string;
  sign(message: string): string;
}

export function newWallet(): TestWallet {
  const keys = nacl.sign.keyPair();
  return {
    wallet: bs58.encode(keys.publicKey),
    sign: (message) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keys.secretKey)),
  };
}
