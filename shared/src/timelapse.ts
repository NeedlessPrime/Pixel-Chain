/**
 * Season timelapse binary format (GET /api/seasons/:id/timelapse.bin).
 *
 * Header (16 bytes, little endian):
 *   0  magic   "PXTL"
 *   4  u16     version (1)
 *   6  u16     width
 *   8  u16     height
 *   10 u16     reserved (0)
 *   12 u32     record count
 * Then `count` records of 5 bytes: u16 x, u16 y, u8 color (palette index or EMPTY),
 * in placement order. Replaying them on an EMPTY canvas rebuilds the final image.
 */
export const TIMELAPSE_MAGIC = 'PXTL';
export const TIMELAPSE_VERSION = 1;
export const TIMELAPSE_HEADER_BYTES = 16;
export const TIMELAPSE_RECORD_BYTES = 5;

export interface TimelapseRecord { x: number; y: number; c: number }

/** Writes the 16-byte header at the start of `buf` (whose records follow it). */
export function writeTimelapseHeader(buf: Uint8Array, width: number, height: number, count: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset, TIMELAPSE_HEADER_BYTES);
  for (let i = 0; i < 4; i++) buf[i] = TIMELAPSE_MAGIC.charCodeAt(i);
  view.setUint16(4, TIMELAPSE_VERSION, true);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  view.setUint16(10, 0, true);
  view.setUint32(12, count, true);
}

export function encodeTimelapse(width: number, height: number, records: ArrayLike<TimelapseRecord> | TimelapseRecord[]): Uint8Array {
  const count = records.length;
  const buf = new Uint8Array(TIMELAPSE_HEADER_BYTES + count * TIMELAPSE_RECORD_BYTES);
  const view = new DataView(buf.buffer);
  writeTimelapseHeader(buf, width, height, count);
  for (let i = 0; i < count; i++) {
    const r = records[i]!;
    const o = TIMELAPSE_HEADER_BYTES + i * TIMELAPSE_RECORD_BYTES;
    view.setUint16(o, r.x, true);
    view.setUint16(o + 2, r.y, true);
    buf[o + 4] = r.c;
  }
  return buf;
}

export interface DecodedTimelapse {
  width: number;
  height: number;
  count: number;
  /** Record i: x = xs[i], y = ys[i], color = cs[i]. */
  xs: Uint16Array;
  ys: Uint16Array;
  cs: Uint8Array;
}

export function decodeTimelapse(bytes: Uint8Array): DecodedTimelapse {
  if (bytes.length < TIMELAPSE_HEADER_BYTES) throw new Error('timelapse too short');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== TIMELAPSE_MAGIC.charCodeAt(i)) throw new Error('bad timelapse magic');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== TIMELAPSE_VERSION) throw new Error(`unsupported timelapse version ${version}`);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const count = view.getUint32(12, true);
  if (bytes.length < TIMELAPSE_HEADER_BYTES + count * TIMELAPSE_RECORD_BYTES) throw new Error('timelapse truncated');
  const xs = new Uint16Array(count);
  const ys = new Uint16Array(count);
  const cs = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = TIMELAPSE_HEADER_BYTES + i * TIMELAPSE_RECORD_BYTES;
    xs[i] = view.getUint16(o, true);
    ys[i] = view.getUint16(o + 2, true);
    cs[i] = bytes[o + 4]!;
  }
  return { width, height, count, xs, ys, cs };
}
