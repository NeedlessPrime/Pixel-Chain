import { shortWallet } from '@pixel/shared';
import { onTick } from '../clock';
import { fmtChaos, fmtCountdown, fmtInt } from '../format';
import { buyUrl, type GameActions, type GameState, type Store } from '../store';
import { h, setText } from './dom';
import { logo } from './logo';

/** Logo, season + countdown, chaos badge, online count, buy and wallet buttons, menu. */
export function mountTopBar(root: HTMLElement, store: Store<GameState>, actions: GameActions): void {
  const title = h('span', { class: 'season-title' });
  const countdown = h('span', { class: 'season-countdown' });
  const chaos = h('span', { class: 'chaos-badge', hidden: true, title: 'Fin de saison : délais réduits' });
  const online = h('span', { class: 'online', title: 'Joueurs connectés' });
  const buy = h(
    'a',
    { class: 'btn btn-buy', target: '_blank', rel: 'noopener', hidden: true },
    'Acheter',
    h('span', { class: 'hide-sm' }, ' $PIXEL'),
  );
  const walletBtn = h('button', { class: 'btn btn-wallet', type: 'button', onclick: () => actions.openWallet() });
  const menuBtn = h(
    'button',
    { class: 'icon-btn menu-btn', type: 'button', 'aria-label': 'Ouvrir le tableau de bord', 'aria-controls': 'panel', onclick: () => actions.togglePanel() },
    h('span', { class: 'burger', 'aria-hidden': 'true' }),
  );

  root.append(
    logo(),
    h('div', { class: 'season' }, title, h('span', { class: 'season-time' }, countdown, chaos)),
    h(
      'div',
      { class: 'topbar-actions' },
      online,
      h('a', { class: 'btn btn-ghost hide-md', href: '/hall' }, 'Hall of Fame'),
      buy,
      walletBtn,
      menuBtn,
    ),
  );

  store.subscribe((s) => {
    const season = s.season;
    setText(title, season ? `Saison ${season.number} · ${season.theme}` : 'Chargement…');
    chaos.hidden = !(season?.status === 'live' && season.chaos.active);
    if (season) setText(chaos, `CHAOS ${fmtChaos(season.chaos.factor)}`);

    const buyHref = buyUrl(s.config);
    buy.hidden = !buyHref;
    if (buyHref) buy.href = buyHref;
    buy.lastElementChild!.textContent = ` ${s.config?.token.symbol ?? '$PIXEL'}`;

    if (s.connection === 'online') {
      setText(online, fmtInt(s.online));
      online.className = 'online';
      online.title = `${fmtInt(s.online)} en ligne`;
    } else {
      setText(online, s.connection === 'connecting' ? 'Connexion…' : 'Hors ligne');
      online.className = 'online is-offline';
      online.title = 'Reconnexion au serveur…';
    }

    walletBtn.classList.toggle('is-connected', !!s.session);
    setText(walletBtn, s.session ? shortWallet(s.session.wallet) : 'Connecter');
    walletBtn.setAttribute('aria-label', s.session ? `Compte ${s.session.wallet}` : 'Connecter un wallet');
  });

  onTick((now) => {
    const season = store.get().season;
    if (!season) return setText(countdown, '');
    if (season.status === 'live') setText(countdown, `fin dans ${fmtCountdown(season.endsAt - now)}`);
    else if (season.nextSeasonAt) setText(countdown, `prochaine dans ${fmtCountdown(season.nextSeasonAt - now)}`);
    else setText(countdown, 'saison terminée');
  });
}
