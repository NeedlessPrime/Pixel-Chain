import { PALETTE } from '@pixel/shared';
import { onTick, serverNow } from '../clock';
import { fmtAmount, fmtCooldown, fmtInt } from '../format';
import { buyUrl, minHolding, placeBlocker, type GameActions, type GameState, type Store } from '../store';
import { h, setChildren, setText } from './dom';

/** Not-holder call to action, palette, selected cell, report and place buttons. */
export function mountBottomBar(root: HTMLElement, store: Store<GameState>, actions: GameActions): void {
  const cta = h('div', { class: 'cta', hidden: true, role: 'status' });
  const palette = h('div', { class: 'palette', role: 'radiogroup', 'aria-label': 'Couleurs' });
  const swatch = h('span', { class: 'cell-swatch', 'aria-hidden': 'true' });
  const coords = h('span', { class: 'cell-coords' });
  const reportBtn = h(
    'button',
    { class: 'icon-btn report-btn', type: 'button', title: 'Signaler cette zone', 'aria-label': 'Signaler cette zone', onclick: () => actions.openReport() },
    '⚑',
  );
  const placeLabel = h('span', { class: 'place-label' });
  const placeBtn = h('button', { class: 'btn btn-place', type: 'button', onclick: () => onPlaceClick() }, placeLabel);

  root.append(
    cta,
    h(
      'div',
      { class: 'bottombar-inner' },
      palette,
      h('div', { class: 'action-row' }, h('div', { class: 'cell-info' }, swatch, coords), reportBtn, placeBtn),
    ),
  );

  const pickHint = matchMedia('(pointer: coarse)').matches ? 'Touche une case' : 'Clique sur une case';
  let renderedPalette: readonly string[] | null = null;
  let swatches: HTMLButtonElement[] = [];
  function renderPalette(colors: readonly string[]): void {
    renderedPalette = colors;
    swatches = colors.map((hex, i) =>
      h('button', {
        class: 'swatch',
        type: 'button',
        role: 'radio',
        style: `--c:${hex}`,
        title: i < 10 ? `${hex} (touche ${(i + 1) % 10})` : hex,
        'aria-label': `Couleur ${i + 1}`,
        // Keep focus off the swatch so Enter/Space still place the pixel after a mouse pick.
        onmousedown: (e: MouseEvent) => e.preventDefault(),
        onclick: () => actions.selectColor(i),
      }),
    );
    setChildren(palette, swatches);
  }

  function onPlaceClick(): void {
    const s = store.get();
    switch (placeBlocker(s, serverNow())) {
      case 'signed_out':
        return actions.openWallet();
      case 'not_holder': {
        const href = buyUrl(s.config);
        if (href) window.open(href, '_blank', 'noopener');
        return;
      }
      default:
        actions.placeSelected();
    }
  }

  function renderCta(s: GameState): void {
    const show = !!(s.config && s.me && !s.me.tier && !s.me.banned && s.season?.status === 'live');
    cta.hidden = !show;
    if (!show || !s.config || !s.me) return;
    const symbol = s.config.token.symbol;
    const buyHref = buyUrl(s.config);
    setChildren(
      cta,
      h(
        'div',
        { class: 'cta-text' },
        h('strong', null, `Achète au moins ${fmtInt(minHolding(s.config))} ${symbol} pour jouer`),
        h(
          'span',
          null,
          `Tu as ${fmtAmount(s.me.balance)} ${symbol}.`,
          s.config.mode === 'mock' ? ' Mode test : règle ton solde fictif en haut.' : ' Ton solde est relu toutes les 30 s.',
        ),
      ),
      buyHref ? h('a', { class: 'btn btn-accent', href: buyHref, target: '_blank', rel: 'noopener' }, `Acheter ${symbol}`) : null,
    );
  }

  /** Label/disabled state of the place button; runs on every store change and tick. */
  function renderPlace(s: GameState, now: number): void {
    const blocker = placeBlocker(s, now);
    let label = 'Placer';
    let disabled = false;
    let progress = 0;
    switch (blocker) {
      case 'loading':
        label = 'Chargement…';
        disabled = true;
        break;
      case 'frozen':
        label = 'Saison terminée';
        disabled = true;
        break;
      case 'signed_out':
        label = 'Connecter mon wallet';
        break;
      case 'offline':
        label = 'Connexion…';
        disabled = true;
        break;
      case 'banned':
        label = 'Wallet banni';
        disabled = true;
        break;
      case 'not_holder': {
        // Without a buy link (coin not launched yet) the call to action above explains what to do.
        const href = buyUrl(s.config);
        label = href ? `Acheter ${s.config!.token.symbol}` : 'Solde insuffisant';
        disabled = !href;
        break;
      }
      case 'cooldown': {
        const left = s.me!.nextPlaceAt - now;
        label = `⏳ ${fmtCooldown(left)}`;
        disabled = true;
        progress = s.me!.cooldownMs ? Math.min(1, left / s.me!.cooldownMs) : 0;
        break;
      }
      case null:
        if (s.placing) {
          label = 'Envoi…';
          disabled = true;
        } else if (!s.selected) {
          label = 'Choisis une case';
          disabled = true;
        }
    }
    setText(placeLabel, label);
    placeBtn.disabled = disabled;
    placeBtn.classList.toggle('is-cooldown', blocker === 'cooldown');
    placeBtn.classList.toggle('is-ready', blocker === null && !!s.selected && !s.placing);
    placeBtn.style.setProperty('--progress', progress.toFixed(3));
  }

  store.subscribe((s, prev) => {
    const colors = s.config?.palette ?? PALETTE;
    if (colors !== renderedPalette) renderPalette(colors);
    swatches.forEach((el, i) => {
      const on = i === s.color;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-checked', String(on));
    });
    setText(coords, s.selected ? `(${s.selected.x}, ${s.selected.y})` : pickHint);
    coords.classList.toggle('is-hint', !s.selected);
    swatch.style.background = colors[s.color] ?? '';
    reportBtn.disabled = !s.selected;
    if (s.me !== prev.me || s.config !== prev.config || s.season !== prev.season || s === prev) renderCta(s);
    renderPlace(s, serverNow());
  });

  onTick((now) => renderPlace(store.get(), now));
}
