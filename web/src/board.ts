import type { CanvasSnapshot } from './api';
import type { CanvasView } from './canvas';

/**
 * The server's view of the canvas plus our own optimistic pixels on top.
 * Keeping them apart makes a rollback exact even if others painted meanwhile.
 */
export class Board {
  width = 0;
  height = 0;
  private colors: Uint8Array = new Uint8Array(0);
  /** Cell index → colour drawn before the server acknowledged it. */
  private readonly pending = new Map<number, number>();

  constructor(private readonly view: CanvasView) {}

  load(snapshot: CanvasSnapshot): void {
    this.width = snapshot.width;
    this.height = snapshot.height;
    this.colors = snapshot.colors;
    this.pending.clear();
    this.view.load(snapshot.width, snapshot.height, snapshot.colors);
  }

  /** Apply a server `px` batch; `onCell` gets each touched cell index. */
  apply(d: number[], onCell: (index: number) => void): void {
    for (let i = 0; i + 2 < d.length; i += 3) {
      const x = d[i]!;
      const y = d[i + 1]!;
      const c = d[i + 2]!;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      const index = y * this.width + x;
      this.colors[index] = c;
      if (!this.pending.has(index)) this.view.setCell(x, y, c);
      onCell(index);
    }
  }

  colorAt(x: number, y: number): number {
    const index = y * this.width + x;
    return this.pending.get(index) ?? this.colors[index]!;
  }

  paintOptimistic(x: number, y: number, c: number): void {
    this.pending.set(y * this.width + x, c);
    this.view.setCell(x, y, c);
  }

  /**
   * The server accepted it. Our pixel is now the newest known for that cell
   * (the ack precedes the `px` frame that will carry it), so it becomes the base.
   */
  confirm(x: number, y: number, c: number): void {
    const index = y * this.width + x;
    if (!this.pending.delete(index)) return;
    this.colors[index] = c;
  }

  rollback(x: number, y: number): void {
    const index = y * this.width + x;
    if (!this.pending.delete(index)) return;
    this.view.setCell(x, y, this.colors[index]!);
  }
}
