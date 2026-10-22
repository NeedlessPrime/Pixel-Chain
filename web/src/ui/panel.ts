import { effectiveCooldownMs, normalizeFaction, shortWallet, type Leaderboard } from '@pixel/shared';
import { onTick } from '../clock';
import { fmtAmount, fmtCompact, fmtCooldown, fmtCount, fmtCountdown, fmtDelay, fmtInt } from '../format';
import type { GameActions, GameState, Store } from '../store';
import { h, setChildren, setText } from './dom';
import { toast } from './toast';

/** Side panel (drawer on phones): my stats, tiers, faction, leaderboard. */
export function mountPanel(root: HTMLElement, store: Store<GameState>, actions: GameActions): void {
  const account = h('div', { class: 'panel-body' });
  const tiers = h('div', { class: 'panel-body' });
  const faction = createFactionSection(store, actions);
  const board = createLeaderboard(store);

  root.append(
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { class: 'panel-title' }, 'Tableau de bord'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fermer le tableau de bord', onclick: () => actions.togglePanel(false) }, '✕'),
    ),
    h(
      'div',
      { class: 'panel-scroll' },
      section('Mon compte', account),
      section('Paliers', tiers),
      section('Faction', faction.el),
      section('Classement', board.el),
      h(
        'nav',
        { class: 'panel-links' },
        h('a', { href: '/hall' }, 'Hall of Fame →'),
        h(
          'p',
          { class: 'muted small' },
          'Une saison dure 7 jours. À la fin, la toile est figée, le logo $PIXEL y est apposé et elle rejoint le Hall of Fame.',
        ),
      ),
    ),
  );

  const cooldownText = h('span');
  store.subscribe((s, prev) => {
    if (s === prev || s.me !== prev.me || s.session !== prev.session || s.config !== prev.config || s.season !== prev.season) {
      renderAccount(s);
      renderTiers(s);
    }
    faction.update(s, prev);
    board.update(s, prev);
  });

  onTick((now) => {
    const me = store.get().me;
    if (!me?.tier) return;
    setText(cooldownText, me.nextPlaceAt > now ? `dans ${fmtCooldown(me.nextPlaceAt - now)}` : 'prêt !');
  });

  function renderAccount(s: GameState): void {
    const symbol = s.config?.token.symbol ?? '$PIXEL';
    if (!s.session) {
      setChildren(
        account,
        h('p', null, 'Connecte ton wallet Solana pour poser des pixels. Une seule signature gratuite, aucune transaction.'),
        h('button', { class: 'btn btn-accent btn-block', type: 'button', onclick: () => actions.openWallet() }, 'Connecter mon wallet'),
      );
      return;
    }
    const me = s.me;
    const refresh = h('button', { class: 'btn btn-sm', type: 'button' }, 'Actualiser');
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      await actions.refreshBalance();
      setTimeout(() => (refresh.disabled = false), 10_000); // server allows one refresh per 10 s
    });
    setChildren(
      account,
      h(
        'dl',
        { class: 'stats' },
        stat('Wallet', shortWallet(s.session.wallet)),
        stat('Solde', me ? `${fmtAmount(me.balance)} ${symbol}` : '…', refresh),
        stat('Palier', me?.banned ? 'Banni' : (me?.tier?.label ?? 'Aucun')),
        stat('Délai', me?.cooldownMs ? `1 pixel / ${fmtDelay(me.cooldownMs)}` : '—'),
        me?.tier ? stat('Prochain pixel', cooldownText) : null,
        stat('Posés cette saison', me ? fmtInt(me.placed) : '…'),
        stat('Sur la toile', me ? fmtInt(me.owned) : '…'),
      ),
    );
  }

  function renderTiers(s: GameState): void {
    const config = s.config;
    if (!config) return;
    const chaos = s.season?.status === 'live' && s.season.chaos.active;
    const sorted = [...config.tiers].sort((a, b) => b.minBalance - a.minBalance);
    setChildren(
      tiers,
      h(
        'ul',
        { class: 'tiers' },
        sorted.map((t) =>
          h(
            'li',
            { class: s.me?.tier?.id === t.id ? 'tier is-current' : 'tier' },
            h('span', { class: 'tier-label' }, t.label),
            h(
              'span',
              null,
              `Garde ${fmtCompact(t.minBalance)} ${config.token.symbol} → `,
              h(
                'span',
                { class: 'nowrap' },
                '1 pixel / ',
                chaos
                  ? [h('s', null, fmtDelay(t.cooldownMs)), ' ', h('strong', { class: 'chaos-text' }, fmtDelay(effectiveCooldownMs(t, true, s.season!.chaos.factor)))]
                  : fmtDelay(effectiveCooldownMs(t, false, 1)),
              ),
            ),
          ),
        ),
      ),
      chaos ? h('p', { class: 'small chaos-text' }, 'CHAOS : délais réduits jusqu’à la fin de la saison !') : null,
    );
  }
}

function section(title: string, body: HTMLElement): HTMLElement {
  return h('section', { class: 'panel-section' }, h('h3', { class: 'panel-section-title' }, title), body);
}

function stat(label: string, value: string | Node, extra?: Node): HTMLElement {
  return h('div', { class: 'stat' }, h('dt', null, label), h('dd', null, value, extra ?? null));
}

/* ---------------- faction ---------------- */

function createFactionSection(store: Store<GameState>, actions: GameActions) {
  const current = h('p', { class: 'faction-current' });
  const lock = h('p', { class: 'small muted', hidden: true });
  const listId = 'faction-suggestions';
  const datalist = h('datalist', { id: listId });
  const input = h('input', {
    class: 'input',
    type: 'text',
    maxLength: 16,
    minLength: 2,
    placeholder: 'Nom de faction',
    list: listId,
    autocomplete: 'off',
    'aria-label': 'Nom de faction',
  });
  const join = h('button', { class: 'btn', type: 'submit' }, 'Rejoindre');
  const leave = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', hidden: true }, 'Quitter ma faction');
  const form = h('form', { class: 'faction-form' }, input, join);
  const el = h(
    'div',
    { class: 'panel-body' },
    current,
    h('p', { class: 'small muted' }, 'Ton territoire compte pour ta faction. Changement possible une fois par heure.'),
    form,
    datalist,
    leave,
    lock,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = normalizeFaction(input.value);
    if (!name) return toast('Nom de faction : 2 à 16 lettres, chiffres, espaces ou $ _ . -', 'error');
    busy = true;
    join.disabled = true;
    if (await actions.setFaction(name)) input.value = '';
    busy = false;
  });
  leave.addEventListener('click', () => void actions.setFaction(null));

  let lockedUntil = 0;
  let busy = false;
  onTick((now) => {
    const locked = lockedUntil > now;
    lock.hidden = !locked;
    join.disabled = busy || locked || !store.get().session;
    leave.disabled = locked;
    if (locked) setText(lock, `Prochain changement possible dans ${fmtCountdown(lockedUntil - now)}`);
  });

  function update(s: GameState, prev: GameState): void {
    if (s !== prev && s.me === prev.me && s.session === prev.session && s.leaderboard === prev.leaderboard && s.config === prev.config) return;
    const mine = s.me?.faction ?? null;
    lockedUntil = s.me?.factionLockedUntil ?? 0;
    current.replaceChildren(
      ...(s.session
        ? mine
          ? ['Tu défends ', h('span', { class: 'tag' }, mine)]
          : ['Tu joues en solo.']
        : ['Connecte ton wallet pour rejoindre une faction.']),
    );
    form.hidden = !s.session;
    leave.hidden = !mine;
    const names = new Set([...(s.config?.factions ?? []), ...(s.leaderboard?.factions.map((f) => f.faction) ?? [])]);
    setChildren(datalist, [...names].map((n) => h('option', { value: n })));
  }

  return { el, update };
}

/* ---------------- leaderboard ---------------- */

function createLeaderboard(store: Store<GameState>) {
  let tab: 'factions' | 'players' = 'factions';
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const list = h('ol', { class: 'ranking' });
  const totals = h('p', { class: 'small muted' });
  const el = h('div', { class: 'panel-body' }, tabs, list, totals);

  const tabBtn = (id: typeof tab, label: string) =>
    h('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      onclick: () => {
        tab = id;
        render(store.get());
      },
    }, label);
  const factionsTab = tabBtn('factions', 'Factions');
  const playersTab = tabBtn('players', 'Joueurs');
  tabs.append(factionsTab, playersTab);

  function render(s: GameState): void {
    factionsTab.setAttribute('aria-selected', String(tab === 'factions'));
    playersTab.setAttribute('aria-selected', String(tab === 'players'));
    const lb: Leaderboard | null = s.leaderboard;
    if (!lb) {
      setChildren(list, h('li', { class: 'muted' }, 'Chargement…'));
      return;
    }
    const me = s.session?.wallet;
    const myFaction = s.me?.faction;
    const rows =
      tab === 'factions'
        ? lb.factions.map((f) =>
            row(f.faction, `${fmtInt(f.pixels)} px`, `${fmtInt(f.players)} joueur${f.players > 1 ? 's' : ''}`, f.faction === myFaction),
          )
        : lb.players.map((p) =>
            row(p.wallet === me ? 'Toi' : shortWallet(p.wallet), `${fmtInt(p.pixels)} px`, p.faction ?? '', p.wallet === me),
          );
    setChildren(list, rows.length ? rows : h('li', { class: 'muted' }, tab === 'factions' ? 'Aucune faction pour l’instant.' : 'Personne n’a encore joué.'));
    setText(totals, `${fmtCount(lb.totalPlacements, 'pixel posé', 'pixels posés')} · ${fmtCount(lb.uniquePlayers, 'joueur')} cette saison`);
  }

  function update(s: GameState, prev: GameState): void {
    if (s === prev || s.leaderboard !== prev.leaderboard || s.me !== prev.me || s.session !== prev.session) render(s);
  }

  return { el, update };
}

function row(name: string, value: string, detail: string, highlight: boolean): HTMLElement {
  return h(
    'li',
    { class: highlight ? 'rank is-me' : 'rank' },
    h('span', { class: 'rank-name' }, name),
    detail ? h('span', { class: 'rank-detail' }, detail) : null,
    h('span', { class: 'rank-value' }, value),
  );
}
