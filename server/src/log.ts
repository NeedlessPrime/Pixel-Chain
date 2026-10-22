import { EMPTY, TIMELAPSE_RECORD_BYTES } from '@pixel/shared';

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

/**
 * Timelapse records with moderated content removed: every record of a cell
 * that an admin erased later is dropped, and so are the erase markers. Replaying
 * the result on an empty canvas still rebuilds the final image exactly.
 *
 * Runs over the raw bytes (a season log can hold tens of millions of records):
 * the kept records are copied, in log layout, into the returned buffer after
 * `reserve` leading bytes left for the caller (e.g. a header).
 */
export function scrubModerated(bytes: Uint8Array, width: number, height: number, reserve = 0): Uint8Array {
  const size = PlacementLog.RECORD_BYTES;
  const end = bytes.length - (bytes.length % size);
  /** Cell index of the record at byte offset o, or -1 when outside the canvas. */
  const cellOf = (o: number): number => {
    const x = bytes[o]! | (bytes[o + 1]! << 8);
    const y = bytes[o + 2]! | (bytes[o + 3]! << 8);
    return x < width && y < height ? y * width + x : -1;
  };

  // Pass 1: index of the last erase of every cell (-1 = never erased).
  const lastErase = new Int32Array(width * height).fill(-1);
  for (let i = 0, o = 0; o < end; i++, o += size) {
    if (bytes[o + 4] !== EMPTY) continue;
    const cell = cellOf(o);
    if (cell >= 0) lastErase[cell] = i;
  }

  // Pass 2: copy the paint no later erase removed.
  const out = new Uint8Array(reserve + end);
  let used = reserve;
  for (let i = 0, o = 0; o < end; i++, o += size) {
    if (bytes[o + 4] === EMPTY) continue;
    const cell = cellOf(o);
    if (cell < 0 || lastErase[cell]! > i) continue;
    out[used] = bytes[o]!;
    out[used + 1] = bytes[o + 1]!;
    out[used + 2] = bytes[o + 2]!;
    out[used + 3] = bytes[o + 3]!;
    out[used + 4] = bytes[o + 4]!;
    used += size;
  }
  return out.subarray(0, used);
}
