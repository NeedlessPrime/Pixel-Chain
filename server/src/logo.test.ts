import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { EMPTY, PALETTE } from '@pixel/shared';
import { builtinLogo, decodeLogoPng, loadLogo, logoOrigin } from './logo';
import { removeDir, tempDir } from './test-helpers';

const index = (hex: string) => PALETTE.indexOf(hex);

describe('built-in logo', () => {
  it('writes $PIXEL in a 5x7 font on a black backing with 1-cell padding', () => {
    const logo = builtinLogo();
    expect([logo.width, logo.height]).toEqual([6 * 6 - 1 + 2, 9]);
    const colours = new Set(logo.pixels);
    expect(colours).toEqual(new Set([index('#000000'), index('#FFFFFF'), index('#FFA800'), index('#FF4500')]));
    expect(logo.pixels[0]).toBe(index('#000000'));
    // Top of the $ bar (glyph column 2, row 0) and the first column of the P.
    expect(logo.pixels[1 * logo.width + 1 + 2]).toBe(index('#FF4500'));
    expect(logo.pixels[1 * logo.width + 1 + 6]).toBe(index('#FFFFFF'));
  });
});

describe('PNG logo', () => {
  let dir = '';
  afterEach(() => removeDir(dir));

  it('skips transparent pixels and snaps colours to the palette', async () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([250, 70, 5, 255, 0, 0, 0, 10]);
    const logo = decodeLogoPng(PNG.sync.write(png));
    expect([...logo.pixels]).toEqual([index('#FF4500'), EMPTY]);

    dir = await tempDir();
    const file = path.join(dir, 'logo.png');
    await writeFile(file, PNG.sync.write(png));
    expect(loadLogo(file).pixels).toEqual(logo.pixels);
  });

  it('falls back to the built-in text when the file is unusable', async () => {
    dir = await tempDir();
    const file = path.join(dir, 'broken.png');
    await writeFile(file, 'not a png');
    const warnings: string[] = [];
    expect(loadLogo(file, (m) => warnings.push(m))).toEqual(builtinLogo());
    expect(warnings).toHaveLength(1);
  });
});

describe('logoOrigin', () => {
  const logo = { width: 10, height: 4, pixels: new Uint8Array(40) };

  it('places the logo bottom-right with a 2-cell margin, or centred', () => {
    expect(logoOrigin(logo, 100, 50, 'bottom-right')).toEqual({ x: 88, y: 44 });
    expect(logoOrigin(logo, 100, 50, 'center')).toEqual({ x: 45, y: 23 });
  });

  it('keeps the top-left part of a logo larger than the canvas', () => {
    expect(logoOrigin(logo, 8, 3, 'bottom-right')).toEqual({ x: 0, y: 0 });
    expect(logoOrigin(logo, 8, 3, 'center')).toEqual({ x: -1, y: -1 });
  });
});
