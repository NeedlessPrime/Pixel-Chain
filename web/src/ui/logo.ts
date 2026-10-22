import { h } from './dom';

/** "$PIXEL" wordmark with the pixel "P" mark, linking home. */
export function logo(): HTMLAnchorElement {
  return h(
    'a',
    { class: 'logo', href: '/', 'aria-label': '$PIXEL — retour à la toile' },
    h('img', { class: 'logo-mark', src: '/favicon.svg', alt: '', width: 28, height: 28 }),
    h('span', { class: 'logo-text' }, h('span', { class: 'logo-dollar' }, '$'), 'PIXEL'),
  );
}
