import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { EMPTY, EMPTY_COLOR, PALETTE, encodeTimelapse, hexToRgb, type SeasonArchive } from '@pixel/shared';
import type { Game } from './game';
import { scrubModerated } from './log';
import { removeTempFiles, writeFileAtomic } from './persistence';

/** How many factions/players the Hall of Fame keeps per season. */
const ARCHIVE_TOP = 10;
const SEASON_ID_RE = /^s[1-9]\d{0,8}$/;

export type ArchiveFile = 'image.png' | 'timelapse.bin';

/** One pixel per cell; EMPTY is drawn as the canvas background colour. */
export function renderPng(colors: Uint8Array, width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  const rgb = PALETTE.map(hexToRgb);
  const empty = hexToRgb(EMPTY_COLOR);
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i]!;
    const [r, g, b] = c === EMPTY ? empty : (rgb[c] ?? empty);
    png.data.set([r, g, b, 255], i * 4);
  }
  return PNG.sync.write(png);
}

/** The season timelapse with moderated content removed. */
export function buildTimelapse(log: Uint8Array, width: number, height: number): Uint8Array {
  return encodeTimelapse(width, height, scrubModerated(log, width, height));
}

export interface ArchiveFiles {
  meta: SeasonArchive;
  image: Buffer;
  timelapse: Uint8Array;
}

export interface ArchivedSeason {
  id: string;
  number: number;
  theme: string;
  startedAt: number;
  endedAt: number;
}

/** Renders everything the Hall of Fame needs from the frozen canvas. */
export function buildArchive(game: Game, season: ArchivedSeason, now: number): ArchiveFiles {
  const lb = game.leaderboard(now);
  const meta: SeasonArchive = {
    ...season,
    width: game.width,
    height: game.height,
    totalPlacements: game.totalPlacements,
    uniquePlayers: lb.uniquePlayers,
    topFactions: lb.factions.slice(0, ARCHIVE_TOP),
    topPlayers: lb.players.slice(0, ARCHIVE_TOP),
    imageUrl: `/api/seasons/${season.id}/image.png`,
    timelapseUrl: `/api/seasons/${season.id}/timelapse.bin`,
  };
  return {
    meta,
    image: renderPng(game.colors, game.width, game.height),
    timelapse: buildTimelapse(game.log.bytes(), game.width, game.height),
  };
}

/** DATA_DIR/archive/<seasonId>/{meta.json,image.png,timelapse.bin} */
export class ArchiveStore {
  private readonly metas = new Map<string, SeasonArchive>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    for (const id of entries.filter((e) => SEASON_ID_RE.test(e))) {
      await removeTempFiles(path.join(this.dir, id));
      try {
        const meta = JSON.parse(await readFile(path.join(this.dir, id, 'meta.json'), 'utf8')) as SeasonArchive;
        this.metas.set(id, meta);
      } catch {
        // Incomplete archive (meta.json is written last): ignore it.
      }
    }
  }

  /** Newest first. */
  list(): SeasonArchive[] {
    return [...this.metas.values()].sort((a, b) => b.number - a.number);
  }

  has(id: string): boolean {
    return this.metas.has(id);
  }

  /** Writes (or rewrites) a season archive. Writes are queued; meta.json goes last. */
  write(files: ArchiveFiles): Promise<void> {
    const run = this.queue.then(async () => {
      const dir = path.join(this.dir, files.meta.id);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(path.join(dir, 'image.png'), files.image);
      await writeFileAtomic(path.join(dir, 'timelapse.bin'), files.timelapse);
      await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(files.meta, null, 2));
      this.metas.set(files.meta.id, files.meta);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Path of an archived file, or null for an unknown season (ids never reach the filesystem unchecked). */
  filePath(id: string, file: ArchiveFile): string | null {
    return this.metas.has(id) ? path.join(this.dir, id, file) : null;
  }
}
