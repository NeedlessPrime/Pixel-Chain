import { EMPTY, TIMELAPSE_RECORD_BYTES, type TimelapseRecord } from '@pixel/shared';

/**
 * Append-only log of every pixel change of a season, in the timelapse record
 * layout (u16 x, u16 y, u8 colour, little endian). Placements and the logo
 * carry a palette colour; a moderation erase (admin wipe or ban) is recorded
 * with colour EMPTY, which players can never place — that is the wipe marker.
 */
export class PlacementLog {
  static readonly RECORD_BYTES = TIMELAPSE_RECORD_BYTES;
  private buf: Uint8Array;
  private used = 0;

  constructor(initial?: Uint8Array) {
    // Drop a trailing partial record (crash during an append).
    const whole = initial ? initial.length - (initial.length % PlacementLog.RECORD_BYTES) : 0;
    this.buf = new Uint8Array(Math.max(4096, whole * 2));
    if (initial) this.buf.set(initial.subarray(0, whole));
    this.used = whole;
  }

  get count(): number {
    return this.used / PlacementLog.RECORD_BYTES;
  }

  get byteLength(): number {
    return this.used;
  }

  append(x: number, y: number, c: number): void {
    if (this.used + PlacementLog.RECORD_BYTES > this.buf.length) this.grow();
    const b = this.buf;
    const o = this.used;
    b[o] = x & 0xff;
    b[o + 1] = x >>> 8;
    b[o + 2] = y & 0xff;
    b[o + 3] = y >>> 8;
    b[o + 4] = c;
    this.used += PlacementLog.RECORD_BYTES;
  }

  /** View of the bytes written so far (valid until the next append). */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.used);
  }

  private grow(): void {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf.subarray(0, this.used));
    this.buf = next;
  }
}

function readRecord(bytes: Uint8Array, i: number): TimelapseRecord {
  const o = i * PlacementLog.RECORD_BYTES;
  return { x: bytes[o]! | (bytes[o + 1]! << 8), y: bytes[o + 2]! | (bytes[o + 3]! << 8), c: bytes[o + 4]! };
}

/**
 * Timelapse records with moderated content removed: every record of a cell
 * that an admin erased later is dropped, and so are the erase markers. Replaying
 * the result on an empty canvas still rebuilds the final image exactly.
 */
export function scrubModerated(bytes: Uint8Array, width: number, height: number): TimelapseRecord[] {
  const count = Math.floor(bytes.length / PlacementLog.RECORD_BYTES);
  const erasedLater = new Uint8Array(width * height);
  const kept: TimelapseRecord[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const rec = readRecord(bytes, i);
    if (rec.x >= width || rec.y >= height) continue;
    const cell = rec.y * width + rec.x;
    if (rec.c === EMPTY) erasedLater[cell] = 1;
    else if (!erasedLater[cell]) kept.push(rec);
  }
  return kept.reverse();
}
