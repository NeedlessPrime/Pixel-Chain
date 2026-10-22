import './style.css';
import './game.css';
import { EMPTY_COLOR, PALETTE, type SeasonInfo } from '@pixel/shared';
import { api, setAuthToken } from './api';
import { Board } from './board';
import { CanvasView } from './canvas';
import { serverNow } from './clock';
import { fmtCooldown, fmtInt } from './format';
import { errorMessage, placeErrorMessage } from './messages';
import { GameSocket, type SocketHandlers } from './socket';
import { createGameStore, minHolding, placeBlocker, type Blocker, type Cell, type GameActions } from './store';
import { mountBanners } from './ui/banners';
import { mountBottomBar } from './ui/bottombar';
import { $, isTyping } from './ui/dom';
import { isModalOpen } from './ui/modal';
import { mountPanel } from './ui/panel';
import { openReportForm } from './ui/report';
import { toast } from './ui/toast';
import { PixelTooltip } from './ui/tooltip';
import { mountTopBar } from './ui/topbar';
import { openAccountMenu, openWalletPicker } from './ui/walletModal';
import { disconnectWallet, loadSession, type SignedIn } from './wallet';

const store = createGameStore();
const hudTop = $('#hud-top');
const hudBottom = $('#bottombar');
const panel = $('#panel');
const wideScreen = matchMedia('(min-width: 1100px)');

let hover: Cell | null = null;

const view = new CanvasView($('#board') as HTMLCanvasElement, {
  onCellClick(cell, pointerType) {
    store.set({ selected: cell });
    // Desktop: a click places right away when ready. Touch: tap selects, the button confirms.
    if (pointerType === 'mouse' && placeBlocker(store.get(), serverNow()) === null) void place(cell);
  },
  onHover(cell) {
    hover = cell;
    tooltip.show(hover ?? store.get().selected);
  },
  onViewChange: () => tooltip.reposition(),
});
const board = new Board(view);
const tooltip = new PixelTooltip({
  view,
  colorAt: (cell) => board.colorAt(cell.x, cell.y),
  palette: () => store.get().config?.palette ?? PALETTE,
  emptyColor: () => store.get().config?.emptyColor ?? EMPTY_COLOR,
  myWallet: () => store.get().session?.wallet ?? null,
});

/* ---------------- server link ---------------- */

let lastSyncErrorToast = 0;
const handlers: SocketHandlers = {
  onSnapshot(config, canvas) {
    view.setPalette(config.palette, config.emptyColor);
    board.load(canvas);
    tooltip.clear();
    const { selected } = store.get();
    const stillOnBoard = selected && selected.x < canvas.width && selected.y < canvas.height;
    store.set({ config, season: config.season, selected: stillOnBoard ? selected : null });
    updateInsets(); // banners may just have appeared: refit to the final HUD now, not on the next resize
    api.leaderboard().then((leaderboard) => store.set({ leaderboard }), () => undefined);
  },
  onPixels(d) {
    board.apply(d, (index) => tooltip.invalidate(index));
  },
  onMessage(msg) {
    switch (msg.t) {
      case 'hello':
        store.set({ online: msg.online, season: msg.season });
        break;
      case 'authed':
        if (msg.ok) store.set({ authed: true, me: msg.me });
        else {
          signOut();
          toast('Session expirée : reconnecte ton wallet.', 'error');
        }
        break;
      case 'me':
        store.set({ me: msg.me });
        break;
      case 'lb':
        store.set({ leaderboard: msg.lb });
        break;
      case 'online':
        store.set({ online: msg.n });
        break;
      case 'season':
        announceSeason(msg.season);
        store.set({ season: msg.season });
        break;
      case 'reload':
        toast(msg.reason === 'season' ? 'Nouvelle saison : la toile est vierge, à vos pixels !' : 'La toile s’agrandit !', 'success', 5000);
        break;
    }
  },
  onStatus(connection) {
    store.set({ connection, authed: connection === 'online' && store.get().authed });
  },
  onSyncError(err) {
    console.warn('canvas sync failed', err);
    if (Date.now() - lastSyncErrorToast > 15_000) {
      lastSyncErrorToast = Date.now();
      toast('Impossible de charger la toile, nouvel essai…', 'error');
    }
  },
};
const socket = new GameSocket(handlers);

function announceSeason(next: SeasonInfo): void {
  const prev = store.get().season;
  if (!prev || prev.id !== next.id) return;
  if (prev.status === 'live' && next.status === 'frozen') toast('Saison terminée ! La toile part au Hall of Fame.', 'info', 6000);
  else if (!prev.chaos.active && next.chaos.active && next.status === 'live') {
    toast('CHAOS ! Délais réduits jusqu’à la fin de la saison.', 'success', 6000);
  }
}

/* ---------------- placing ---------------- */

function explain(blocker: Blocker): void {
  const s = store.get();
  switch (blocker) {
    case 'signed_out':
      return actions.openWallet();
    case 'not_holder':
      return toast(`Achète au moins ${fmtInt(minHolding(s.config!))} ${s.config!.token.symbol} pour jouer.`, 'error');
    case 'cooldown':
      return toast(`Prochain pixel dans ${fmtCooldown(s.me!.nextPlaceAt - serverNow())}`);
    case 'frozen':
      return toast('La saison est terminée : rendez-vous au Hall of Fame !');
    case 'banned':
      return toast('Ce wallet est banni.', 'error');
    case 'offline':
      return toast('Connexion au serveur en cours…');
    case 'loading':
      return;
  }
}

async function place(cell: Cell): Promise<void> {
  const s = store.get();
  const now = serverNow();
  const blocker = placeBlocker(s, now);
  if (blocker) return explain(blocker);
  if (s.placing || !s.me) return;
  const color = s.color;
  const before = s.me;
  board.paintOptimistic(cell.x, cell.y, color);
  // Start the countdown immediately; the ack brings the server's exact value.
  store.set({ placing: true, me: { ...before, nextPlaceAt: now + (before.cooldownMs ?? 0) } });

  const result = await socket.place(cell.x, cell.y, color);
  const me = store.get().me;
  if (result.ok) {
    board.confirm(cell.x, cell.y, color);
    tooltip.invalidate(cell.y * board.width + cell.x);
    store.set({ placing: false, me: { ...result.me, nextPlaceAt: result.nextPlaceAt } });
    return;
  }
  board.rollback(cell.x, cell.y);
  store.set({ placing: false, me: me && { ...me, nextPlaceAt: result.nextPlaceAt ?? before.nextPlaceAt } });
  const config = store.get().config;
  toast(placeErrorMessage(result, config ? minHolding(config) : 0, config?.token.symbol ?? '$PIXEL'), 'error');
  if (result.code === 'unauthenticated') signOut();
}

/* ---------------- session ---------------- */

function signedIn({ session, me }: SignedIn): void {
  setAuthToken(session.token);
  store.set({ session, me });
  socket.setToken(session.token);
  toast('Wallet connecté !', 'success');
}

function signOut(): void {
  void disconnectWallet();
  setAuthToken(null);
  store.set({ session: null, me: null, authed: false });
  socket.setToken(null);
}

/* ---------------- actions for the HUD ---------------- */

const actions: GameActions = {
  openWallet() {
    const s = store.get();
    if (s.session) openAccountMenu(s.session, s.me, s.config?.token.symbol ?? '$PIXEL', signOut);
    else openWalletPicker(s.config?.mode === 'mock', signedIn);
  },
  placeSelected() {
    const { selected } = store.get();
    if (selected) void place(selected);
  },
  selectColor(index) {
    const palette = store.get().config?.palette ?? PALETTE;
    if (index >= 0 && index < palette.length) store.set({ color: index });
  },
  openReport() {
    const s = store.get();
    if (!s.selected) return;
    if (!s.session) {
      toast('Connecte ton wallet pour signaler une zone.');
      return actions.openWallet();
    }
    openReportForm(s.selected, view);
  },
  togglePanel(open) {
    const next = open ?? !document.body.classList.contains('panel-open');
    document.body.classList.toggle('panel-open', next);
    $('.menu-btn').setAttribute('aria-expanded', String(next));
    updateInsets();
  },
  async setFaction(name) {
    try {
      store.set({ me: await api.setFaction(name) });
      toast(name ? `Bienvenue chez ${name} !` : 'Tu joues maintenant en solo.', 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error'); // e.g. "Tu pourras changer de faction dans 42 min"
      return false;
    }
  },
  async refreshBalance() {
    try {
      store.set({ me: await api.me(true) });
      toast('Solde mis à jour.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  },
  async setDevBalance(balance) {
    try {
      store.set({ me: await api.devBalance(balance) });
      toast(`Solde fictif : ${fmtInt(balance)}`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  },
};

/* ---------------- layout ---------------- */

/** The HUD covers parts of the canvas: tell the view, and CSS, how much. */
function updateInsets(): void {
  const top = hudTop.offsetHeight;
  const bottom = hudBottom.offsetHeight;
  const docked = wideScreen.matches && document.body.classList.contains('panel-open');
  document.documentElement.style.setProperty('--hud-top', `${top}px`);
  document.documentElement.style.setProperty('--hud-bottom', `${bottom}px`);
  view.setInsets({ top, bottom, left: 0, right: docked ? panel.offsetWidth : 0 });
}

new ResizeObserver(updateInsets).observe(hudTop);
new ResizeObserver(updateInsets).observe(hudBottom);
wideScreen.addEventListener('change', updateInsets);
$('#panel-backdrop').addEventListener('click', () => actions.togglePanel(false));

/* ---------------- keyboard ---------------- */

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

document.addEventListener('keydown', (e) => {
  if (isTyping(e.target) || isModalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
  const s = store.get();
  const arrow = ARROWS[e.key];
  if (arrow) {
    const from = s.selected ?? view.centerCell();
    if (!from) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const cell = {
      x: Math.min(board.width - 1, Math.max(0, from.x + arrow[0] * step)),
      y: Math.min(board.height - 1, Math.max(0, from.y + arrow[1] * step)),
    };
    store.set({ selected: cell });
    view.ensureVisible(cell);
    return;
  }
  // Enter/Space on a focused button already activate it.
  const onControl = e.target instanceof HTMLElement && e.target.closest('button, a');
  if ((e.key === 'Enter' || e.key === ' ') && !onControl && s.selected) {
    e.preventDefault();
    actions.placeSelected();
  } else if (e.key === 'Escape') {
    if (document.body.classList.contains('panel-open') && !wideScreen.matches) actions.togglePanel(false);
    else store.set({ selected: null });
  } else if (e.key === '+' || e.key === '=') view.zoomBy(1.5);
  else if (e.key === '-') view.zoomBy(1 / 1.5);
  else if (/^[0-9]$/.test(e.key)) actions.selectColor(e.key === '0' ? 9 : Number(e.key) - 1);
});

/* ---------------- boot ---------------- */

mountTopBar($('#topbar'), store, actions);
mountBanners($('#banners'), store, actions);
mountBottomBar(hudBottom, store, actions);
mountPanel(panel, store, actions);

store.subscribe((s, prev) => {
  if (s.selected !== prev.selected || s.color !== prev.color || s.config !== prev.config || s === prev) {
    const palette = s.config?.palette ?? PALETTE;
    view.setSelected(s.selected, palette[s.color] ?? null);
    if (!hover) tooltip.show(s.selected);
  }
});

actions.togglePanel(wideScreen.matches); // docked by default on wide screens, closed drawer on phones

const session = loadSession();
if (session) {
  setAuthToken(session.token);
  socket.setToken(session.token);
  store.set({ session });
}
socket.start();
