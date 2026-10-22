import { h } from './dom';

export type ToastKind = 'info' | 'error' | 'success';

const MAX_TOASTS = 3;
let root: HTMLElement | null = null;

function container(): HTMLElement {
  if (!root) {
    root = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(root);
  }
  return root;
}

/** Short message near the bottom of the screen, gone after a few seconds. */
export function toast(message: string, kind: ToastKind = 'info', durationMs = 3500): void {
  const box = container();
  // The same message twice in a row (spam-clicking) just restarts its timer.
  const last = box.lastElementChild as HTMLElement | null;
  if (last?.textContent === message) last.remove();
  const el = h('div', { class: `toast toast-${kind}` }, message);
  box.appendChild(el);
  while (box.children.length > MAX_TOASTS) box.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 200);
  }, durationMs);
}
