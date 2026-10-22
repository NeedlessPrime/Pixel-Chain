import { h } from './dom';

export interface Modal {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
}

let current: Modal | null = null;

/** Centred dialog (bottom sheet on phones). Escape, the backdrop and × close it. */
export function openModal(title: string, opts: { onClose?: () => void; className?: string } = {}): Modal {
  current?.close();
  const previousFocus = document.activeElement as HTMLElement | null;
  const body = h('div', { class: 'modal-body' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fermer' }, '✕');
  const titleId = `modal-title-${Date.now()}`;
  const dialog = h(
    'div',
    { class: `modal ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId, class: 'modal-title' }, title), closeBtn),
    body,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      modal.close();
    }
  };
  const modal: Modal = {
    el: dialog,
    body,
    close() {
      if (current !== modal) return;
      current = null;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      opts.onClose?.();
      previousFocus?.focus?.();
    },
  };
  closeBtn.addEventListener('click', () => modal.close());
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) modal.close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  current = modal;
  // Focus the dialog itself: focusing a field would pop the keyboard up on phones.
  requestAnimationFrame(() => dialog.focus());
  return modal;
}

export function isModalOpen(): boolean {
  return current !== null;
}
