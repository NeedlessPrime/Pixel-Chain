import { EMPTY, hexToRgb } from '@pixel/shared';
import type { Cell } from './store';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CanvasViewEvents {
  /** A click or tap (not a drag) on a cell. */
  onCellClick(cell: Cell, pointerType: string): void;
  onHover(cell: Cell | null): void;
  /** Pan or zoom changed (overlays anchored to cells must follow). */
  onViewChange(): void;
}

export const MAX_SCALE = 40;
export const GRID_MIN_SCALE = 12;
const OUTSIDE_COLOR = '#07070B';
const FRAME_COLOR = '#2C2C3A';
const ACCENT = '#FF4500';
/** Movement (CSS px) under which a press still counts as a click/tap. */
const TAP_SLOP = { mouse: 4, touch: 10 };

/**
 * Renders the board: a w×h offscreen canvas (1 px per cell, updated through
 * ImageData) drawn scaled with smoothing off, plus overlays. Handles pan/zoom
 * input and only repaints on the next animation frame after something changed.
 */
export class CanvasView {
  width = 0;
  height = 0;
  /** CSS px per cell. */
  scale = 1;
  /** Screen position (CSS px) of the top-left corner of cell (0, 0). */
  private ox = 0;
  private oy = 0;
  private viewW = 0;
  private viewH = 0;
  private dpr = 1;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Until the player pans or zooms, the board stays fitted to the free area (the HUD settles late). */
  private interacted = false;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly offscreen = document.createElement('canvas');
  private readonly octx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private pixels = new Uint32Array(0);
  /** Palette index → ABGR (little-endian RGBA), EMPTY included. */
  private rgba = new Uint32Array(256);
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private frame = 0;

  private hover: Cell | null = null;
  private selected: Cell | null = null;
  private previewColor: string | null = null;
  private highlight: Rect | null = null;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: {
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    tap: boolean;
    pinch: { dist: number; scale: number; worldX: number; worldY: number } | null;
  } | null = null;

  constructor(
    readonly el: HTMLCanvasElement,
    private readonly events: CanvasViewEvents,
  ) {
    const ctx = el.getContext('2d', { alpha: false });
    const octx = this.offscreen.getContext('2d');
    if (!ctx || !octx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.octx = octx;
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  /* ---------------- content ---------------- */

  setPalette(palette: readonly string[], emptyColor: string): void {
    const pack = (hex: string) => {
      const [r, g, b] = hexToRgb(hex);
      return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    };
    this.rgba.fill(pack(emptyColor));
    palette.forEach((hex, i) => (this.rgba[i] = pack(hex)));
    this.rgba[EMPTY] = pack(emptyColor);
  }

  /** Replace the whole board (snapshot). Once the player has moved the view, it is kept. */
  load(width: number, height: number, colors: Uint8Array): void {
    const resized = width !== this.width || height !== this.height;
    if (resized || !this.image) {
      this.width = width;
      this.height = height;
      this.offscreen.width = width;
      this.offscreen.height = height;
      this.image = this.octx.createImageData(width, height);
      this.pixels = new Uint32Array(this.image.data.buffer);
    }
    for (let i = 0; i < colors.length; i++) this.pixels[i] = this.rgba[colors[i]!]!;
    this.dirty = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
    if (!this.interacted) this.fit();
    else if (resized) this.clampPan();
    this.invalidate();
  }

  setCell(x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = this.rgba[color]!;
    const d = this.dirty;
    if (!d) this.dirty = { x0: x, y0: y, x1: x, y1: y };
    else {
      d.x0 = Math.min(d.x0, x);
      d.y0 = Math.min(d.y0, y);
      d.x1 = Math.max(d.x1, x);
      d.y1 = Math.max(d.y1, y);
    }
    this.invalidate();
  }

  setSelected(cell: Cell | null, previewColor: string | null): void {
    this.selected = cell;
    this.previewColor = previewColor;
    this.invalidate();
  }

  /** Outline an area (the zone being reported). */
  setHighlight(rect: Rect | null): void {
    this.highlight = rect;
    this.invalidate();
  }

  /* ---------------- view ---------------- */

  /** Area of the screen not covered by the HUD, used to fit and to keep the selection visible. */
  setInsets(insets: Insets): void {
    this.insets = insets;
    if (!this.interacted) this.fit();
  }

  get minScale(): number {
    return Math.min(1, this.fitScale());
  }

  private fitScale(): number {
    if (!this.width) return 1;
    const { top, right, bottom, left } = this.insets;
    const w = Math.max(1, this.viewW - left - right - 16);
    const h = Math.max(1, this.viewH - top - bottom - 16);
    return Math.min(w / this.width, h / this.height);
  }

  fit(): void {
    if (!this.width || !this.viewW) return;
    this.scale = Math.min(MAX_SCALE, this.fitScale());
    const { top, right, bottom, left } = this.insets;
    this.ox = left + (this.viewW - left - right - this.width * this.scale) / 2;
    this.oy = top + (this.viewH - top - bottom - this.height * this.scale) / 2;
    this.changed();
  }

  zoomAt(sx: number, sy: number, scale: number): void {
    const next = clamp(scale, this.minScale, MAX_SCALE);
    const k = next / this.scale;
    this.ox = sx - (sx - this.ox) * k;
    this.oy = sy - (sy - this.oy) * k;
    this.scale = next;
    this.clampPan();
    this.changed();
  }

  /** Zoom around the centre of the visible area (keyboard, buttons). */
  zoomBy(factor: number): void {
    this.interacted = true;
    const { top, right, bottom, left } = this.insets;
    this.zoomAt((left + this.viewW - right) / 2, (top + this.viewH - bottom) / 2, this.scale * factor);
  }

  /** Pan just enough for a cell to be inside the visible area. */
  ensureVisible(cell: Cell): void {
    const { top, right, bottom, left } = this.insets;
    const margin = Math.max(this.scale * 2, 24);
    const p = this.cellToScreen(cell);
    let dx = 0;
    let dy = 0;
    if (p.x < left + margin) dx = left + margin - p.x;
    else if (p.x + this.scale > this.viewW - right - margin) dx = this.viewW - right - margin - p.x - this.scale;
    if (p.y < top + margin) dy = top + margin - p.y;
    else if (p.y + this.scale > this.viewH - bottom - margin) dy = this.viewH - bottom - margin - p.y - this.scale;
    if (dx || dy) {
      this.ox += dx;
      this.oy += dy;
      this.changed();
    }
  }

  cellToScreen(cell: Cell): { x: number; y: number; size: number } {
    return { x: this.ox + cell.x * this.scale, y: this.oy + cell.y * this.scale, size: this.scale };
  }

  screenToCell(sx: number, sy: number): Cell | null {
    const x = Math.floor((sx - this.ox) / this.scale);
    const y = Math.floor((sy - this.oy) / this.scale);
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? { x, y } : null;
  }

  /** Cell at the centre of the visible area (starting point for keyboard navigation). */
  centerCell(): Cell | null {
    const { top, right, bottom, left } = this.insets;
    const cell = this.screenToCell((left + this.viewW - right) / 2, (top + this.viewH - bottom) / 2);
    return cell ?? (this.width ? { x: this.width >> 1, y: this.height >> 1 } : null);
  }

  /** Keep the board's centre inside the visible area so it can never be lost off-screen. */
  private clampPan(): void {
    const { top, right, bottom, left } = this.insets;
    const halfW = (this.width * this.scale) / 2;
    const halfH = (this.height * this.scale) / 2;
    this.ox = clamp(this.ox + halfW, left, this.viewW - right) - halfW;
    this.oy = clamp(this.oy + halfH, top, this.viewH - bottom) - halfH;
  }

  private changed(): void {
    this.invalidate();
    this.events.onViewChange();
  }

  private resize(): void {
    const rect = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cx = (this.viewW / 2 - this.ox) / this.scale;
    const cy = (this.viewH / 2 - this.oy) / this.scale;
    this.viewW = rect.width;
    this.viewH = rect.height;
    this.dpr = dpr;
    this.el.width = Math.round(rect.width * dpr);
    this.el.height = Math.round(rect.height * dpr);
    if (!this.interacted) this.fit();
    else {
      // Keep the same board point in the middle of the screen.
      this.ox = this.viewW / 2 - cx * this.scale;
      this.oy = this.viewH / 2 - cy * this.scale;
      this.clampPan();
      this.changed();
    }
    this.invalidate();
  }

  /* ---------------- drawing ---------------- */

  invalidate(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    this.frame = 0;
    const { ctx, scale, dpr } = this;
    if (this.image && this.dirty) {
      const d = this.dirty;
      this.octx.putImageData(this.image, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
      this.dirty = null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = OUTSIDE_COLOR;
    ctx.fillRect(0, 0, this.viewW, this.viewH);
    if (!this.width) return;

    // Snap the origin to device pixels so cell edges stay crisp.
    const ox = Math.round(this.ox * dpr) / dpr;
    const oy = Math.round(this.oy * dpr) / dpr;
    const x0 = clamp(Math.floor(-ox / scale), 0, this.width);
    const y0 = clamp(Math.floor(-oy / scale), 0, this.height);
    const x1 = clamp(Math.ceil((this.viewW - ox) / scale), 0, this.width);
    const y1 = clamp(Math.ceil((this.viewH - oy) / scale), 0, this.height);

    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(ox - 1, oy - 1, this.width * scale + 2, this.height * scale + 2);

    if (x1 > x0 && y1 > y0) {
      ctx.imageSmoothingEnabled = false;
      // Only the visible part: at 40× a full 1000-cell board would be a 40 000 px wide draw.
      ctx.drawImage(this.offscreen, x0, y0, x1 - x0, y1 - y0, ox + x0 * scale, oy + y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale);
    }

    if (scale >= GRID_MIN_SCALE) {
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const sx = ox + x * scale;
        ctx.moveTo(sx, oy + y0 * scale);
        ctx.lineTo(sx, oy + y1 * scale);
      }
      for (let y = y0; y <= y1; y++) {
        const sy = oy + y * scale;
        ctx.moveTo(ox + x0 * scale, sy);
        ctx.lineTo(ox + x1 * scale, sy);
      }
      ctx.strokeStyle = 'rgba(128, 128, 140, 0.28)';
      ctx.lineWidth = 1 / dpr;
      ctx.stroke();
    }

    if (this.highlight) {
      const r = this.highlight;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#FFD635';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + r.x * scale - 1, oy + r.y * scale - 1, r.w * scale + 2, r.h * scale + 2);
      ctx.setLineDash([]);
    }

    if (this.hover && !this.sameCell(this.hover, this.selected)) this.drawReticle(this.hover, ox, oy, '#FFFFFF');
    if (this.selected) {
      if (this.previewColor && scale >= 6) {
        const inset = Math.max(1, scale * 0.2);
        ctx.fillStyle = this.previewColor;
        ctx.fillRect(ox + this.selected.x * scale + inset, oy + this.selected.y * scale + inset, scale - inset * 2, scale - inset * 2);
      }
      this.drawReticle(this.selected, ox, oy, ACCENT);
    }
  }

  /** Square outline around a cell, never smaller than 10 px so it shows when zoomed out. */
  private drawReticle(cell: Cell, ox: number, oy: number, color: string): void {
    const { ctx, scale } = this;
    const size = Math.max(scale, 10);
    const x = ox + cell.x * scale + scale / 2 - size / 2;
    const y = oy + cell.y * scale + scale / 2 - size / 2;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(x - 2, y - 2, size + 4, size + 4);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.strokeRect(x - 2, y - 2, size + 4, size + 4);
  }

  private sameCell(a: Cell | null, b: Cell | null): boolean {
    return !!a && !!b && a.x === b.x && a.y === b.y;
  }

  /* ---------------- input ---------------- */

  private bindInput(): void {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerup', (e) => this.onPointerUp(e, true));
    el.addEventListener('pointercancel', (e) => this.onPointerUp(e, false));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.setHover(null);
    });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari page-zoom gestures would fight our own pinch.
    el.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    this.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.gesture = { startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false, tap: e.button === 0, pinch: null };
    } else if (this.pointers.size === 2 && this.gesture) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.gesture.tap = false;
      this.gesture.pinch = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        scale: this.scale,
        worldX: (mid.x - this.ox) / this.scale,
        worldY: (mid.y - this.oy) / this.scale,
      };
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    if (e.pointerType === 'mouse' && !this.pointers.size) {
      this.setHover(this.screenToCell(p.x, p.y));
      return;
    }
    if (!this.pointers.has(e.pointerId) || !this.gesture) return;
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;

    if (g.pinch && this.pointers.size >= 2) {
      this.interacted = true;
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      this.scale = clamp((g.pinch.scale * dist) / g.pinch.dist, this.minScale, MAX_SCALE);
      // Keep the board point that started under the fingers' midpoint under it.
      this.ox = mid.x - g.pinch.worldX * this.scale;
      this.oy = mid.y - g.pinch.worldY * this.scale;
      this.clampPan();
      this.changed();
      return;
    }

    if (!g.moved) {
      const slop = e.pointerType === 'mouse' ? TAP_SLOP.mouse : TAP_SLOP.touch;
      if (Math.hypot(p.x - g.startX, p.y - g.startY) < slop) return;
      g.moved = true;
      g.tap = false;
      this.interacted = true;
    }
    this.ox += p.x - g.lastX;
    this.oy += p.y - g.lastY;
    g.lastX = p.x;
    g.lastY = p.y;
    this.clampPan();
    this.changed();
    if (e.pointerType === 'mouse') this.setHover(this.screenToCell(p.x, p.y));
  }

  private onPointerUp(e: PointerEvent, completed: boolean): void {
    if (!this.pointers.has(e.pointerId)) return;
    const g = this.gesture;
    if (completed && g?.tap && this.pointers.size === 1) {
      const p = this.local(e);
      const cell = this.screenToCell(p.x, p.y);
      if (cell) this.events.onCellClick(cell, e.pointerType);
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1 && g) {
      // Pinch ended with one finger still down: continue as a pan from where it is.
      const [rest] = [...this.pointers.values()] as [{ x: number; y: number }];
      g.pinch = null;
      g.moved = true;
      g.lastX = rest.x;
      g.lastY = rest.y;
    } else if (this.pointers.size === 0) this.gesture = null;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.interacted = true;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewH : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas: amplify it.
    const speed = e.ctrlKey ? 0.01 : 0.0015;
    const factor = Math.exp(-e.deltaY * unit * speed);
    const p = this.local(e);
    this.zoomAt(p.x, p.y, this.scale * factor);
    this.setHover(this.screenToCell(p.x, p.y));
  }

  private setHover(cell: Cell | null): void {
    if (this.sameCell(cell, this.hover) || (!cell && !this.hover)) return;
    this.hover = cell;
    this.invalidate();
    this.events.onHover(cell);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
