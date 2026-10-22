import { EMPTY, shortWallet, type PixelInfo } from '@pixel/shared';
import { ApiRequestError, api } from '../api';
import type { CanvasView } from '../canvas';
import { serverNow } from '../clock';
import { fmtAgo } from '../format';
import type { Cell } from '../store';
import { h, setChildren } from './dom';

const FETCH_DEBOUNCE_MS = 300;
const CACHE_MAX = 300;
/** Owners can change faction (their pixels follow), so cached entries also age out. */
const CACHE_TTL_MS = 30_000;
/** The server allows 120 requests/min per IP for everything: hover lookups get at most a third. */
const LOOKUPS_PER_MINUTE = 40;
const LOOKUP_BURST = 8;

/** Token bucket: how long to wait before the next lookup may go out. */
class RequestBudget {
  private tokens = LOOKUP_BURST;
  private last = Date.now();

  /** 0 = go now (a token is taken), else the delay in ms until one is available. */
  take(): number {
    const now = Date.now();
    this.tokens = Math.min(LOOKUP_BURST, this.tokens + ((now - this.last) * LOOKUPS_PER_MINUTE) / 60_000);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) * 60_000) / LOOKUPS_PER_MINUTE);
  }

  /** The server said 429: stop asking for a while. */
  drain(): void {
    this.tokens = -LOOKUP_BURST;
    this.last = Date.now();
  }
}

export interface TooltipContext {
  view: CanvasView;
  /** Colour currently drawn at a cell (palette index or EMPTY). */
  colorAt(cell: Cell): number;
  palette(): readonly string[];
  emptyColor(): string;
  myWallet(): string | null;
}

/** Floating "who painted this" card for the hovered or selected cell. */
export class PixelTooltip {
  private readonly el = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  private cell: Cell | null = null;
  private readonly cache = new Map<number, { info: PixelInfo; at: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private readonly budget = new RequestBudget();

  constructor(private readonly ctx: TooltipContext) {
    document.body.appendChild(this.el);
  }

  show(cell: Cell | null): void {
    if (cell && this.cell && cell.x === this.cell.x && cell.y === this.cell.y) return;
    this.cell = cell;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    if (!cell) {
      this.el.hidden = true;
      return;
    }
    const cached = this.cache.get(this.key(cell));
    if (cached && serverNow() - cached.at < CACHE_TTL_MS) this.render(cell, cached.info);
    else {
      this.render(cell, null);
      this.timer = setTimeout(() => void this.load(cell), FETCH_DEBOUNCE_MS);
    }
  }

  /** A `px` touched this cell: forget what we knew about it. */
  invalidate(index: number): void {
    if (!this.cache.delete(index) || !this.cell) return;
    if (index === this.key(this.cell)) {
      const cell = this.cell;
      this.cell = null;
      this.show(cell);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  /** Follow the cell after a pan/zoom; hide when it leaves the screen. */
  reposition(): void {
    if (!this.cell || this.el.hidden) return;
    const { x, y, size } = this.ctx.view.cellToScreen(this.cell);
    const rect = this.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (x + size < 0 || y + size < 0 || x > vw || y > vh) {
      this.el.style.visibility = 'hidden';
      return;
    }
    this.el.style.visibility = '';
    const gap = Math.max(8, size > 10 ? 6 : 10);
    let left = x + size / 2 - rect.width / 2;
    let top = y - rect.height - gap;
    if (top < 64) top = y + size + gap; // no room above (top bar): go below
    left = Math.min(Math.max(8, left), vw - rect.width - 8);
    top = Math.min(Math.max(8, top), vh - rect.height - 8);
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  private key(cell: Cell): number {
    return cell.y * this.ctx.view.width + cell.x;
  }

  private async load(cell: Cell): Promise<void> {
    const wait = this.budget.take();
    if (wait > 0) {
      // Over budget: the card keeps coordinates and colour, the owner shows up a bit later.
      this.timer = setTimeout(() => void this.load(cell), wait);
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    try {
      const info = await api.pixel(cell.x, cell.y, abort.signal);
      this.cache.set(this.key(cell), { info, at: serverNow() });
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      if (this.cell === cell) this.render(cell, info);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 429) this.budget.drain();
    }
  }

  private render(cell: Cell, info: PixelInfo | null): void {
    const color = this.ctx.colorAt(cell);
    const hex = color === EMPTY ? this.ctx.emptyColor() : (this.ctx.palette()[color] ?? this.ctx.emptyColor());
    const head = h(
      'div',
      { class: 'tooltip-head' },
      h('span', { class: 'tooltip-swatch', style: `background:${hex}` }),
      h('span', { class: 'tooltip-coords' }, `(${cell.x}, ${cell.y})`),
    );
    setChildren(this.el, head, h('div', { class: 'tooltip-body' }, this.describe(color, info)));
    this.el.hidden = false;
    this.reposition();
  }

  private describe(color: number, info: PixelInfo | null): (Node | string)[] {
    if (!info) return [color === EMPTY ? 'Case vide' : h('span', { class: 'muted' }, '…')];
    if (info.system) return [h('strong', { class: 'accent' }, 'Logo $PIXEL')];
    if (!info.wallet) return ['Case vide'];
    const mine = info.wallet === this.ctx.myWallet();
    return [
      h(
        'div',
        { class: 'tooltip-owner' },
        mine ? 'Toi' : shortWallet(info.wallet),
        info.faction ? h('span', { class: 'tag' }, info.faction) : null,
      ),
      info.placedAt ? h('div', { class: 'muted' }, fmtAgo(info.placedAt, serverNow())) : '',
    ];
  }
}
