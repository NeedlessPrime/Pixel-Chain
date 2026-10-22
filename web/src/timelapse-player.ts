import { EMPTY, hexToRgb, type DecodedTimelapse } from '@pixel/shared';

export type Speed = 1 | 4 | 16 | 'max';

export interface PlayerState {
  position: number;
  count: number;
  playing: boolean;
}

/** At ×1 a whole season replays in about two minutes (but never slower than 10 pixels/s). */
const BASE_DURATION_S = 120;
const MIN_RATE = 10;
/** "max" replays everything in about 1.5 s of frames. */
const MAX_SPEED_FRAMES = 90;

/**
 * Replays timelapse records onto a w×h canvas (1 px per cell, scaled by CSS).
 * Records are applied in chunks straight into an ImageData buffer, which is
 * pushed to the canvas once per animation frame.
 */
export class TimelapsePlayer {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private readonly rgba = new Uint32Array(256);
  private position = 0;
  private playing = false;
  private speed: Speed = 4;
  private raf = 0;
  private lastTime = 0;
  /** Fractional records carried over between frames at low speeds. */
  private carry = 0;

  constructor(
    private readonly tl: DecodedTimelapse,
    palette: readonly string[],
    emptyColor: string,
    private readonly onChange: (state: PlayerState) => void,
  ) {
    this.canvas.width = tl.width;
    this.canvas.height = tl.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.image = ctx.createImageData(tl.width, tl.height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    const pack = (hex: string) => {
      const [r, g, b] = hexToRgb(hex);
      return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    };
    this.rgba.fill(pack(emptyColor));
    palette.forEach((hex, i) => (this.rgba[i] = pack(hex)));
    this.rgba[EMPTY] = pack(emptyColor);
    this.seek(tl.count); // open on the final image
  }

  get count(): number {
    return this.tl.count;
  }

  /** Show the canvas as it was after `target` records. Going back replays from the start (a few ms even for 1M records). */
  seek(target: number): void {
    target = Math.max(0, Math.min(this.tl.count, Math.floor(target)));
    if (target < this.position) {
      this.pixels.fill(this.rgba[EMPTY]!);
      this.position = 0;
    }
    this.apply(this.position, target);
    this.position = target;
    this.ctx.putImageData(this.image, 0, 0);
    this.emit();
  }

  play(): void {
    if (this.playing || this.tl.count === 0) return;
    if (this.position >= this.tl.count) this.seek(0);
    this.playing = true;
    this.lastTime = performance.now();
    this.carry = 0;
    this.raf = requestAnimationFrame((t) => this.tick(t));
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
  }

  destroy(): void {
    this.pause();
  }

  private tick(now: number): void {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000); // a background tab must not jump ahead
    this.lastTime = now;
    let step: number;
    if (this.speed === 'max') step = Math.max(500, this.tl.count / MAX_SPEED_FRAMES);
    else step = Math.max(MIN_RATE, this.tl.count / BASE_DURATION_S) * this.speed * dt + this.carry;
    const whole = Math.floor(step);
    this.carry = step - whole;
    this.seek(this.position + whole);
    if (this.position >= this.tl.count) this.pause();
    else this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private apply(from: number, to: number): void {
    const { xs, ys, cs, width, height } = this.tl;
    const px = this.pixels;
    const rgba = this.rgba;
    for (let i = from; i < to; i++) {
      const x = xs[i]!;
      const y = ys[i]!;
      if (x < width && y < height) px[y * width + x] = rgba[cs[i]!]!;
    }
  }

  private emit(): void {
    this.onChange({ position: this.position, count: this.tl.count, playing: this.playing });
  }
}
