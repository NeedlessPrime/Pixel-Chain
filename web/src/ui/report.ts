import { MAX_REPORT_SIZE } from '@pixel/shared';
import { api } from '../api';
import type { CanvasView, Rect } from '../canvas';
import { errorMessage } from '../messages';
import type { Cell } from '../store';
import { h, setText } from './dom';
import { openModal } from './modal';
import { toast } from './toast';

const SIZES = [8, 16, 32, 64].filter((n) => n <= MAX_REPORT_SIZE);
const REASON_MAX = 300;

/** A size×size square centred on the cell, shifted to stay on the board. */
export function reportZone(cell: Cell, size: number, width: number, height: number): Rect {
  const w = Math.min(size, width);
  const hgt = Math.min(size, height);
  const x = Math.min(Math.max(0, cell.x - Math.floor(w / 2)), width - w);
  const y = Math.min(Math.max(0, cell.y - Math.floor(hgt / 2)), height - hgt);
  return { x, y, w, h: hgt };
}

/** "Signaler" form: zone around the selected cell + reason → POST /api/report. */
export function openReportForm(cell: Cell, view: CanvasView): void {
  let size = SIZES[1] ?? SIZES[0]!;
  let zone = reportZone(cell, size, view.width, view.height);
  const modal = openModal('Signaler une zone', { className: 'modal-report', onClose: () => view.setHighlight(null) });
  view.ensureVisible(cell);

  const zoneText = h('p', { class: 'small muted' });
  const sizeButtons = SIZES.map((n) =>
    h('button', { class: 'chip', type: 'button', onclick: () => pick(n) }, `${n}×${n}`),
  );
  const reason = h('textarea', {
    class: 'input',
    rows: 3,
    maxLength: REASON_MAX,
    required: true,
    placeholder: 'Contenu haineux, choquant, données personnelles…',
    'aria-label': 'Raison du signalement',
  });
  const submit = h('button', { class: 'btn btn-accent btn-block', type: 'submit' }, 'Envoyer le signalement');
  const form = h(
    'form',
    { class: 'form' },
    h('p', null, 'Montre à la modération une zone qui enfreint les règles. Elle est entourée en jaune sur la toile.'),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Taille de la zone'), h('div', { class: 'chips' }, sizeButtons)),
    zoneText,
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Raison'), reason),
    submit,
  );
  modal.body.append(form);

  function pick(n: number): void {
    size = n;
    zone = reportZone(cell, size, view.width, view.height);
    sizeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(SIZES[i] === n)));
    setText(zoneText, `Zone : de (${zone.x}, ${zone.y}) à (${zone.x + zone.w - 1}, ${zone.y + zone.h - 1})`);
    view.setHighlight(zone);
  }
  pick(size);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = reason.value.trim();
    if (text.length < 3) {
      toast('Explique en quelques mots ce qui pose problème.', 'error');
      return;
    }
    submit.disabled = true;
    try {
      await api.report({ ...zone, reason: text });
      toast('Merci ! La modération va regarder.', 'success');
      modal.close();
    } catch (err) {
      toast(errorMessage(err), 'error');
      submit.disabled = false;
    }
  });
}
