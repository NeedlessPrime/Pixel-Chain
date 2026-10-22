/**
 * The 32-colour palette (same as r/place 2022). A canvas cell stores an index
 * into this array, or EMPTY when nobody has painted it yet.
 */
export const PALETTE: readonly string[] = [
  '#6D001A', '#BE0039', '#FF4500', '#FFA800', '#FFD635', '#FFF8B8', '#00A368', '#00CC78',
  '#7EED56', '#00756F', '#009EAA', '#00CCC0', '#2450A4', '#3690EA', '#51E9F4', '#493AC1',
  '#6A5CFF', '#94B3FF', '#811E9F', '#B44AC0', '#E4ABFF', '#DE107F', '#FF3881', '#FF99AA',
  '#6D482F', '#9C6926', '#FFB470', '#000000', '#515252', '#898D90', '#D4D7D9', '#FFFFFF',
];

/** Cell value for a pixel nobody has painted (or that moderation erased). */
export const EMPTY = 255;

/** How EMPTY cells are drawn: the dark background of the canvas. */
export const EMPTY_COLOR = '#0E0E14';

export function isValidColor(c: unknown): c is number {
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < PALETTE.length;
}

/** "#RRGGBB" -> [r, g, b] */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Index of the palette colour closest to an RGB value (used to map a logo PNG onto the palette). */
export function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  PALETTE.forEach((hex, i) => {
    const [pr, pg, pb] = hexToRgb(hex);
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}
