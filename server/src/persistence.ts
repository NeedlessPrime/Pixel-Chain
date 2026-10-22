import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameSnapshot } from './game';
import { PlacementLog } from './log';
import type { ReportsSnapshot } from './reports';
import type { SeasonState } from './season';

export const STATE_VERSION = 1;

/** Everything in state.json; the canvas arrays live in their own binary files. */
export interface PersistedState {
  version: typeof STATE_VERSION;
  season: SeasonState;
  game: GameSnapshot;
  reports: ReportsSnapshot;
  mockBalances?: Record<string, number>;
}

/** A consistent copy of the state, taken synchronously, written asynchronously. */
export interface SaveSnapshot {
  state: PersistedState;
  colors: Uint8Array;
  owners: Uint32Array;
  times: Uint32Array;
  seasonId: string;
  /** The season log so far (append-only, so a view is stable). */
  log: Uint8Array;
}

export interface LoadedState {
  state: PersistedState;
  colors: Uint8Array;
  owners: Uint32Array;
  times: Uint32Array;
  log: Uint8Array;
}

let tmpCounter = 0;

/** Write to a temporary file then rename, so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  await writeFile(tmp, data, mode === undefined ? undefined : { mode });
  await rename(tmp, file);
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Copies into a fresh, aligned buffer (file buffers may sit at any offset of a shared pool). */
function toUint32(buf: Buffer): Uint32Array {
  if (buf.length % 4 !== 0) throw new Error('corrupted 32-bit array file');
  return new Uint32Array(new Uint8Array(buf).buffer);
}

function bytesOf(arr: Uint32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** The HMAC key for session tokens: SESSION_SECRET, or a random one kept in DATA_DIR/secret. */
export async function loadOrCreateSecret(dataDir: string): Promise<string> {
  const file = path.join(dataDir, 'secret');
  const existing = (await readOptional(file))?.toString('utf8').trim();
  if (existing && existing.length >= 32) return existing;
  const secret = randomBytes(32).toString('hex');
  await mkdir(dataDir, { recursive: true });
  await writeFileAtomic(file, secret, 0o600);
  return secret;
}

/**
 * Files under DATA_DIR: state.json, canvas.bin, owners.bin, times.bin (atomic
 * rewrites) and log-<seasonId>.bin (append-only: only new records are written).
 */
export class Persistence {
  private logSeasonId: string | null = null;
  private logFlushed = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {}

  async load(): Promise<LoadedState | null> {
    const raw = await readOptional(this.file('state.json'));
    if (!raw) return null;
    const state = JSON.parse(raw.toString('utf8')) as PersistedState;
    if (state.version !== STATE_VERSION) throw new Error(`unsupported state.json version ${state.version}`);
    const [colors, owners, times] = await Promise.all(['canvas.bin', 'owners.bin', 'times.bin'].map(async (name) => {
      const buf = await readOptional(this.file(name));
      if (!buf) throw new Error(`${name} is missing next to state.json`);
      return buf;
    }));
    const seasonId = `s${state.season.number}`;
    const log = (await readOptional(this.logFile(seasonId))) ?? new Uint8Array(0);
    const whole = log.length - (log.length % PlacementLog.RECORD_BYTES);
    // A partial trailing record (crash mid-append) forces a full rewrite at the next save.
    this.logSeasonId = whole === log.length ? seasonId : null;
    this.logFlushed = whole;
    return { state, colors: new Uint8Array(colors!), owners: toUint32(owners!), times: toUint32(times!), log };
  }

  /** Saves are queued so two of them never interleave. */
  save(snap: SaveSnapshot): Promise<void> {
    const run = this.queue.then(() => this.write(snap));
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(snap: SaveSnapshot): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await this.writeLog(snap.seasonId, snap.log);
    await writeFileAtomic(this.file('canvas.bin'), snap.colors);
    await writeFileAtomic(this.file('owners.bin'), bytesOf(snap.owners));
    await writeFileAtomic(this.file('times.bin'), bytesOf(snap.times));
    // Written last: the binaries above always match or are newer than the state they belong to.
    await writeFileAtomic(this.file('state.json'), JSON.stringify(snap.state));
  }

  private async writeLog(seasonId: string, log: Uint8Array): Promise<void> {
    const file = this.logFile(seasonId);
    try {
      if (seasonId !== this.logSeasonId || log.length < this.logFlushed) {
        await writeFileAtomic(file, log);
      } else if (log.length > this.logFlushed) {
        await appendFile(file, log.subarray(this.logFlushed));
      }
    } catch (err) {
      this.logSeasonId = null; // unknown file content: rewrite it whole next time
      throw err;
    }
    this.logSeasonId = seasonId;
    this.logFlushed = log.length;
  }

  private file(name: string): string {
    return path.join(this.dataDir, name);
  }

  private logFile(seasonId: string): string {
    return this.file(`log-${seasonId}.bin`);
  }
}
