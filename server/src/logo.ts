import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { EMPTY, MAX_CANVAS_SIZE, PALETTE, nearestPaletteIndex } from '@pixel/shared';
import type { LogoPosition } from './config';
import type { Bitmap } from './game';

/** Cells kept free between the logo and the canvas edge in the bottom-right position. */
const MARGIN = 2;
/** Pixels with less opacity than this are treated as transparent. */
const ALPHA_THRESHOLD = 128;

/** Decodes a PNG logo: transparent pixels are skipped, colours snapped to the palette. */
export function decodeLogoPng(data: Buffer): Bitmap {
  const png = PNG.sync.read(data);
  if (png.width > MAX_CANVAS_SIZE || png.height > MAX_CANVAS_SIZE) throw new Error('logo larger than the largest canvas');
  const pixels = new Uint8Array(png.width * png.height).fill(EMPTY);
  for (let i = 0; i < pixels.length; i++) {
    const [r, g, b, a] = png.data.subarray(i * 4, i * 4 + 4);
    if (a! >= ALPHA_THRESHOLD) pixels[i] = nearestPaletteIndex(r!, g!, b!);
  }
  return { width: png.width, height: png.height, pixels };
}

/* Built-in "$PIXEL" in a 5×7 pixel font. '#' = main colour, '|' = accent (the bar of the $). */
const GLYPHS: Record<string, string[]> = {
  $: ['..|..', '.####', '#.|..', '.###.', '..|.#', '####.', '..|..'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
};
const GLYPH_W = 5;
const GLYPH_H = 7;
const PADDING = 1;

const color = (hex: string) => PALETTE.indexOf(hex);
const BACKING = color('#000000');
const LETTER = color('#FFFFFF');
const DOLLAR = color('#FFA800');
const DOLLAR_BAR = color('#FF4500');

/** "$PIXEL" in white letters (orange $) on a black backing rectangle. */
export function builtinLogo(text = '$PIXEL'): Bitmap {
  const chars = [...text].filter((ch) => GLYPHS[ch]);
  const width = chars.length * (GLYPH_W + 1) - 1 + 2 * PADDING;
  const height = GLYPH_H + 2 * PADDING;
  const pixels = new Uint8Array(width * height).fill(BACKING);
  chars.forEach((ch, n) => {
    GLYPHS[ch]!.forEach((row, gy) => {
      [...row].forEach((mark, gx) => {
        if (mark === '.') return;
        const main = ch === '$' ? DOLLAR : LETTER;
        pixels[(PADDING + gy) * width + PADDING + n * (GLYPH_W + 1) + gx] = mark === '|' ? DOLLAR_BAR : main;
      });
    });
  });
  return { width, height, pixels };
}

/** The configured PNG logo, or the built-in text when there is none or it cannot be read. */
export function loadLogo(path: string | null, warn: (msg: string) => void = () => {}): Bitmap {
  if (!path) return builtinLogo();
  try {
    return decodeLogoPng(readFileSync(path));
  } catch (err) {
    warn(`cannot use logo ${path} (${(err as Error).message}), using the built-in $PIXEL text`);
    return builtinLogo();
  }
}

/**
 * Top-left cell where the logo goes. A logo larger than the canvas is clipped:
 * centred it loses both sides, bottom-right it keeps its top-left part.
 */
export function logoOrigin(logo: Bitmap, width: number, height: number, position: LogoPosition): { x: number; y: number } {
  if (position === 'center') {
    return { x: Math.floor((width - logo.width) / 2), y: Math.floor((height - logo.height) / 2) };
  }
  return { x: Math.max(0, width - logo.width - MARGIN), y: Math.max(0, height - logo.height - MARGIN) };
}
