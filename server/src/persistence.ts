import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameSnapshot } from './game';
import { PlacementLog } from './log';
import type { ReportsSnapshot } from './reports';
import type { SeasonState } from './season';

export const STATE_VERSION = 1;
export const SNAPSHOT_FILE = 'snapshot.bin';
/** Before snapshot.bin, the state was spread over these files (still loaded once, then migrated). */
const LEGACY_FILES = ['state.json', 'canvas.bin', 'owners.bin', 'times.bin'] as const;

/** The JSON part of the snapshot; the canvas arrays follow it in binary. */
export interface PersistedState {
  version: typeof STATE_VERSION;
  season: SeasonState;
  game: GameSnapshot;
  reports: ReportsSnapshot;
  mockBalances?: Record<string, number>;
  /** Length of the season log this snapshot includes (absent in the legacy layout). */
  logBytes?: number;
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
  /** Loaded from the legacy multi-file layout: save once to migrate it. */
  legacy: boolean;
}

type Canvas = Omit<LoadedState, 'log' | 'legacy'>;

let tmpCounter = 0;

/** Write to a temporary file then rename, so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Deletes the leftovers of writes a crash interrupted. */
export async function removeTempFiles(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => n.endsWith('.tmp')).map((n) => rm(path.join(dir, n), { force: true })));
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
function toUint32(buf: Uint8Array): Uint32Array {
  if (buf.length % 4 !== 0) throw new Error('corrupted 32-bit array');
  return new Uint32Array(new Uint8Array(buf).buffer);
}

function bytesOf(arr: Uint32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function parseState(json: Uint8Array): PersistedState {
  const state = JSON.parse(Buffer.from(json).toString('utf8')) as PersistedState;
  if (state.version !== STATE_VERSION) throw new Error(`unsupported state version ${state.version}`);
  return state;
}

/**
 * snapshot.bin: u32 LE length of the JSON state, the JSON state (UTF-8), then
 * colors (u8 per cell), owners and times (u32 LE per cell), row-major.
 */
export function encodeSnapshot(state: PersistedState, colors: Uint8Array, owners: Uint32Array, times: Uint32Array): Buffer {
  const json = Buffer.from(JSON.stringify(state), 'utf8');
  const parts = [json, colors, bytesOf(owners), bytesOf(times)];
  const out = Buffer.allocUnsafe(4 + parts.reduce((n, p) => n + p.length, 0));
  out.writeUInt32LE(json.length, 0);
  let offset = 4;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function decodeSnapshot(buf: Uint8Array): Canvas {
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.length < 4) throw new Error(`${SNAPSHOT_FILE} is truncated`);
  const start = 4 + view.readUInt32LE(0);
  const state = parseState(view.subarray(4, start));
  const cells = state.game.width * state.game.height;
  if (view.length !== start + cells * 9) {
    throw new Error(`${SNAPSHOT_FILE} does not match its ${state.game.width}x${state.game.height} canvas`);
  }
  return {
    state,
    colors: new Uint8Array(view.subarray(start, start + cells)),
    owners: toUint32(view.subarray(start + cells, start + cells * 5)),
    times: toUint32(view.subarray(start + cells * 5)),
  };
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
 * Files under DATA_DIR: snapshot.bin (the whole state, replaced atomically by
 * one rename) and log-<seasonId>.bin (append-only: only new records are written).
 */
export class Persistence {
  private logSeasonId: string | null = null;
  private logFlushed = 0;
  private legacy = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {}

  async load(): Promise<LoadedState | null> {
    await removeTempFiles(this.dataDir);
    const snapshot = await readOptional(this.file(SNAPSHOT_FILE));
    const canvas = snapshot ? decodeSnapshot(snapshot) : await this.loadLegacy();
    if (!canvas) return null;
    this.legacy = !snapshot;
    return { ...canvas, log: await this.loadLog(canvas.state), legacy: this.legacy };
  }

  /** Saves are queued so two of them never interleave. */
  save(snap: SaveSnapshot): Promise<void> {
    const run = this.queue.then(() => this.write(snap));
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(snap: SaveSnapshot): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    // The log goes first: the snapshot records how much of it is committed.
    await this.writeLog(snap.seasonId, snap.log);
    const state = { ...snap.state, logBytes: snap.log.length };
    await writeFileAtomic(this.file(SNAPSHOT_FILE), encodeSnapshot(state, snap.colors, snap.owners, snap.times));
    if (this.legacy) {
      await Promise.all(LEGACY_FILES.map((name) => rm(this.file(name), { force: true })));
      this.legacy = false;
    }
  }

  /** The pre-snapshot.bin layout, where a crash between renames could leave the files out of step. */
  private async loadLegacy(): Promise<Canvas | null> {
    const raw = await readOptional(this.file('state.json'));
    if (!raw) return null;
    const state = parseState(raw);
    const [colors, owners, times] = await Promise.all(LEGACY_FILES.slice(1).map(async (name) => {
      const buf = await readOptional(this.file(name));
      if (!buf) throw new Error(`${name} is missing next to state.json`);
      return buf;
    }));
    return { state, colors: new Uint8Array(colors!), owners: toUint32(owners!), times: toUint32(times!) };
  }

  /**
   * The season log, cut to what the snapshot includes: records appended by a save
   * whose snapshot never landed, or a torn last record, are dropped.
   */
  private async loadLog(state: PersistedState): Promise<Uint8Array> {
    const seasonId = `s${state.season.number}`;
    const file = (await readOptional(this.logFile(seasonId))) ?? new Uint8Array(0);
    const usable = Math.min(file.length, state.logBytes ?? file.length);
    const whole = usable - (usable % PlacementLog.RECORD_BYTES);
    // A file longer than what is kept forces a full rewrite at the next save.
    this.logSeasonId = whole === file.length ? seasonId : null;
    this.logFlushed = whole;
    return file.subarray(0, whole);
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
