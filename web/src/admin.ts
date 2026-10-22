import './style.css';
import './admin.css';
import {
  EMPTY_COLOR,
  MAX_CANVAS_SIZE,
  PALETTE,
  isValidWallet,
  shortWallet,
  type AreaOwners,
  type PublicConfig,
  type Report,
} from '@pixel/shared';
import { ApiRequestError, api, fetchCanvas, request, type CanvasSnapshot } from './api';
import { fmtCount, fmtDateTime, fmtInt } from './format';
import { errorMessage } from './messages';
import { $, h, setChildren } from './ui/dom';
import { logo } from './ui/logo';
import { toast } from './ui/toast';

const TOKEN_KEY = 'pixel.adminToken';
/** Longest side of a report preview, in CSS px. */
const PREVIEW_PX = 240;

const app = $('#app');
const nav = h('nav', { class: 'site-nav' });
setChildren($('#header'), h('div', { class: 'admin-brand' }, logo(), h('span', { class: 'admin-badge' }, 'Modération')), nav);

let token = readToken();
let config: PublicConfig | null = null;
let canvas: CanvasSnapshot | null = null;
let reports: Report[] = [];
let showResolved = false;

/* ---------------- token & requests ---------------- */

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(value: string | null): void {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Kept in memory only.
  }
}

const adminGet = <T>(path: string) => request<T>(path, { headers: { 'x-admin-token': token ?? '' } });
/** Admin POSTs answer `{ ok: true }`; wipe and ban also say how many cells they erased. */
interface AdminResult {
  ok: true;
  erased?: number;
}
const adminPost = (path: string, body: unknown = {}) =>
  request<AdminResult>(path, { method: 'POST', body, headers: { 'x-admin-token': token ?? '' } });

/** "Zone effacée (12 pixels)." */
const erased = (label: string) => (res: AdminResult) =>
  res.erased === undefined ? `${label}.` : `${label} (${fmtInt(res.erased)} pixel${res.erased > 1 ? 's' : ''}).`;

function isAuthError(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 401 || err.status === 403);
}

/** Run an admin action; on success toast and refresh, on a refused token go back to the prompt. */
async function run(done: string | ((res: AdminResult) => string), action: () => Promise<AdminResult>): Promise<void> {
  try {
    const res = await action();
    toast(typeof done === 'string' ? done : done(res), 'success');
    await loadAll();
  } catch (err) {
    if (isAuthError(err)) {
      saveToken(null);
      renderLogin('Jeton refusé.');
    } else toast(errorMessage(err), 'error');
  }
}

/* ---------------- login ---------------- */

function renderLogin(message?: string): void {
  setChildren(nav, h('a', { class: 'btn btn-ghost', href: '/' }, 'Toile'));
  const input = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    'aria-label': 'Jeton admin',
    placeholder: 'ADMIN_TOKEN',
  });
  const form = h(
    'form',
    { class: 'login card form' },
    h('h1', { class: 'page-title' }, 'Modération'),
    h('p', { class: 'muted' }, 'Entre le jeton admin du serveur. Il reste dans cet onglet uniquement.'),
    message ? h('p', { class: 'error-text', role: 'alert' }, message) : null,
    input,
    h('button', { class: 'btn btn-accent', type: 'submit' }, 'Entrer'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    saveToken(value);
    void loadAll();
  });
  setChildren(app, form);
  input.focus();
}

/* ---------------- data ---------------- */

async function loadAll(): Promise<void> {
  if (!token) return renderLogin();
  try {
    [reports, config, canvas] = await Promise.all([adminGet<Report[]>('/api/admin/reports'), api.config(), fetchCanvas()]);
  } catch (err) {
    if (isAuthError(err)) {
      saveToken(null);
      return renderLogin('Jeton refusé.');
    }
    if (err instanceof ApiRequestError && err.status === 404) {
      saveToken(null);
      return renderLogin('API admin désactivée : définis ADMIN_TOKEN côté serveur.');
    }
    setChildren(app, h('div', { class: 'card pad' }, h('p', null, errorMessage(err)), h('button', { class: 'btn', type: 'button', onclick: () => void loadAll() }, 'Réessayer')));
    return;
  }
  renderDashboard();
}

/* ---------------- dashboard ---------------- */

function renderDashboard(): void {
  setChildren(
    nav,
    h('button', { class: 'btn', type: 'button', onclick: () => void loadAll() }, 'Actualiser'),
    h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      onclick: () => {
        saveToken(null);
        renderLogin();
      },
    }, 'Déconnexion'),
  );
  setChildren(
    app,
    h(
      'div',
      { class: 'admin-grid' },
      h('section', { class: 'admin-reports' }, reportsSection()),
      h('div', { class: 'admin-tools' }, seasonTool(), wipeTool(), banTool(), resizeTool()),
    ),
  );
}

function reportsSection(): Node[] {
  const open = reports.filter((r) => r.status === 'open');
  const visible = showResolved ? reports : open;
  const toggle = h('input', {
    type: 'checkbox',
    checked: showResolved,
    onchange: () => {
      showResolved = toggle.checked;
      renderDashboard();
    },
  });
  return [
    h(
      'div',
      { class: 'section-head' },
      h('h2', { class: 'section-title' }, `Signalements · ${fmtInt(open.length)} ouvert${open.length > 1 ? 's' : ''}`),
      h('label', { class: 'check' }, toggle, 'Voir les résolus'),
    ),
    visible.length
      ? h('div', { class: 'report-list' }, visible.map(reportCard))
      : h('p', { class: 'card pad muted' }, 'Aucun signalement à traiter.'),
  ];
}

function reportCard(r: Report): HTMLElement {
  const inspect = h('div', { class: 'inspect small muted' }, 'Clique un pixel de l’aperçu pour voir son auteur.');
  const owners = h('div', { class: 'small', hidden: true, style: { display: 'grid', gap: '6px' } });
  return h(
    'article',
    { class: `report card ${r.status === 'resolved' ? 'is-resolved' : ''}` },
    reportPreview(r, (x, y) => void inspectCell(x, y, inspect)),
    h(
      'div',
      { class: 'report-body' },
      h(
        'div',
        { class: 'report-meta' },
        h('strong', null, `(${r.x}, ${r.y}) · ${r.w}×${r.h}`),
        h('span', { class: `status status-${r.status}` }, r.status === 'open' ? 'Ouvert' : 'Résolu'),
      ),
      h('p', { class: 'small muted' }, `${fmtDateTime(r.createdAt)} · par ${shortWallet(r.wallet)}`),
      h('blockquote', { class: 'reason' }, r.reason),
      inspect,
      owners,
      h(
        'div',
        { class: 'actions' },
        h('button', {
          class: 'btn btn-danger btn-sm',
          type: 'button',
          onclick: () => {
            if (confirm(`Effacer la zone (${r.x}, ${r.y}) ${r.w}×${r.h} ?`)) {
              void run(erased('Zone effacée'), () => adminPost('/api/admin/wipe', { x: r.x, y: r.y, w: r.w, h: r.h }));
            }
          },
        }, 'Effacer la zone'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => void listOwners(r, owners) }, 'Qui a dessiné ici ?'),
        r.status === 'open'
          ? h('button', {
              class: 'btn btn-sm',
              type: 'button',
              onclick: () => void run('Signalement résolu.', () => adminPost(`/api/admin/reports/${encodeURIComponent(r.id)}/resolve`)),
            }, 'Marquer résolu')
          : null,
      ),
    ),
  );
}

/** The reported area plus some context around it, one block per cell, the area outlined. */
function reportPreview(r: Report, onPick: (x: number, y: number) => void): HTMLElement {
  if (!canvas) return h('div', { class: 'preview muted small' }, 'Aperçu indisponible');
  const snap = canvas;
  const margin = Math.max(4, Math.ceil(Math.max(r.w, r.h) / 2));
  const x0 = Math.max(0, r.x - margin);
  const y0 = Math.max(0, r.y - margin);
  const x1 = Math.min(snap.width, r.x + r.w + margin);
  const y1 = Math.min(snap.height, r.y + r.h + margin);
  const aw = Math.max(1, x1 - x0);
  const ah = Math.max(1, y1 - y0);
  const k = Math.max(2, Math.floor(PREVIEW_PX / Math.max(aw, ah)));
  const el = h('canvas', { class: 'preview', width: aw * k, height: ah * k, title: 'Clique un pixel pour voir son auteur' });
  const ctx = el.getContext('2d')!;
  const palette = config?.palette ?? PALETTE;
  const empty = config?.emptyColor ?? EMPTY_COLOR;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      ctx.fillStyle = palette[snap.colors[y * snap.width + x]!] ?? empty;
      ctx.fillRect((x - x0) * k, (y - y0) * k, k, k);
    }
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000';
  ctx.strokeRect((r.x - x0) * k - 2, (r.y - y0) * k - 2, r.w * k + 4, r.h * k + 4);
  ctx.strokeStyle = '#FFD635';
  ctx.strokeRect((r.x - x0) * k, (r.y - y0) * k, r.w * k, r.h * k);
  el.addEventListener('click', (e) => {
    const rect = el.getBoundingClientRect();
    const x = x0 + Math.floor(((e.clientX - rect.left) / rect.width) * aw);
    const y = y0 + Math.floor(((e.clientY - rect.top) / rect.height) * ah);
    onPick(x, y);
  });
  return el;
}

async function inspectCell(x: number, y: number, out: HTMLElement): Promise<void> {
  setChildren(out, `(${x}, ${y}) : …`);
  try {
    const info = await api.pixel(x, y);
    if (info.system) return setChildren(out, `(${x}, ${y}) : logo $PIXEL`);
    if (!info.wallet) return setChildren(out, `(${x}, ${y}) : case vide`);
    const wallet = info.wallet;
    setChildren(
      out,
      h('span', null, `(${x}, ${y}) : `, h('code', { title: wallet }, shortWallet(wallet)), info.faction ? ` [${info.faction}]` : ''),
      h('span', { class: 'actions' }, banButton(wallet, false, 'Bannir'), banButton(wallet, true, 'Bannir + effacer')),
    );
  } catch (err) {
    setChildren(out, errorMessage(err));
  }
}

/** Every wallet that owns pixels in the reported area, with ban buttons. */
async function listOwners(r: Report, out: HTMLElement): Promise<void> {
  out.hidden = false;
  setChildren(out, 'Recherche des auteurs…');
  try {
    const { owners } = await adminGet<AreaOwners>(`/api/admin/owners?x=${r.x}&y=${r.y}&w=${r.w}&h=${r.h}`);
    if (!owners.length) return setChildren(out, 'Aucun pixel de joueur dans cette zone.');
    setChildren(
      out,
      owners.map((o) =>
        h(
          'div',
          { class: 'inspect' },
          h('span', null, h('code', { title: o.wallet }, shortWallet(o.wallet)), o.faction ? ` [${o.faction}]` : '', ` · ${fmtCount(o.pixels, 'pixel')}`),
          h('span', { class: 'actions' }, banButton(o.wallet, false, 'Bannir'), banButton(o.wallet, true, 'Bannir + effacer')),
        ),
      ),
    );
  } catch (err) {
    if (isAuthError(err)) {
      saveToken(null);
      return renderLogin('Jeton refusé.');
    }
    setChildren(out, errorMessage(err));
  }
}

function banButton(wallet: string, wipe: boolean, label: string): HTMLElement {
  return h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: () => ban(wallet, wipe) }, label);
}

function ban(wallet: string, wipe: boolean): void {
  if (!confirm(`Bannir ${wallet}${wipe ? ' et effacer tous ses pixels' : ''} ?`)) return;
  void run(wipe ? erased('Wallet banni, pixels effacés') : 'Wallet banni.', () => adminPost('/api/admin/ban', { wallet, wipe }));
}

/* ---------------- tools ---------------- */

function tool(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'tool card' }, h('h2', { class: 'section-title' }, title), ...children);
}

function numberField(label: string, value: number, min: number, max: number): [HTMLElement, HTMLInputElement] {
  const input = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), step: '1', value: String(value), required: true });
  return [h('label', { class: 'field' }, h('span', { class: 'label' }, label), input), input];
}

function seasonTool(): HTMLElement {
  const season = config!.season;
  const live = season.status === 'live';
  return tool(
    'Saison',
    h('p', null, h('strong', null, `Saison ${season.number} · ${season.theme}`)),
    h(
      'p',
      { class: 'small muted' },
      live
        ? `En cours, fin le ${fmtDateTime(season.endsAt)}${season.chaos.active ? ' · chaos actif' : ''}`
        : `Terminée${season.nextSeasonAt ? `, la suivante démarre le ${fmtDateTime(season.nextSeasonAt)}` : ''}`,
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', {
        class: 'btn btn-danger',
        type: 'button',
        disabled: !live,
        onclick: () => {
          if (confirm('Terminer la saison maintenant ? La toile sera figée et archivée.')) void run('Saison terminée.', () => adminPost('/api/admin/season/end'));
        },
      }, 'Terminer la saison'),
      h('button', {
        class: 'btn',
        type: 'button',
        disabled: live,
        onclick: () => {
          if (confirm('Démarrer la saison suivante maintenant ?')) void run('Nouvelle saison démarrée.', () => adminPost('/api/admin/season/start'));
        },
      }, 'Démarrer la suivante'),
    ),
  );
}

function wipeTool(): HTMLElement {
  const w = canvas?.width ?? config!.width;
  const hgt = canvas?.height ?? config!.height;
  const [fx, ix] = numberField('x', 0, 0, w - 1);
  const [fy, iy] = numberField('y', 0, 0, hgt - 1);
  const [fw, iw] = numberField('largeur', 8, 1, w);
  const [fh, ih] = numberField('hauteur', 8, 1, hgt);
  const form = h('form', { class: 'form' }, h('div', { class: 'grid-4' }, fx, fy, fw, fh), h('button', { class: 'btn btn-danger', type: 'submit' }, 'Effacer le rectangle'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const rect = { x: Number(ix.value), y: Number(iy.value), w: Number(iw.value), h: Number(ih.value) };
    if (confirm(`Effacer (${rect.x}, ${rect.y}) ${rect.w}×${rect.h} ?`)) void run(erased('Rectangle effacé'), () => adminPost('/api/admin/wipe', rect));
  });
  return tool('Effacer un rectangle', form);
}

function banTool(): HTMLElement {
  const wallet = h('input', { class: 'input', type: 'text', placeholder: 'Adresse du wallet', autocomplete: 'off', spellcheck: false, 'aria-label': 'Adresse du wallet' });
  const wipe = h('input', { type: 'checkbox' });
  const valid = (): string | null => {
    const w = wallet.value.trim();
    if (isValidWallet(w)) return w;
    toast('Adresse Solana invalide.', 'error');
    return null;
  };
  return tool(
    'Bannir / débannir',
    h(
      'div',
      { class: 'form' },
      wallet,
      h('label', { class: 'check' }, wipe, 'Effacer aussi tous ses pixels'),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { const w = valid(); if (w) ban(w, wipe.checked); } }, 'Bannir'),
        h('button', {
          class: 'btn',
          type: 'button',
          onclick: () => {
            const w = valid();
            if (w) void run('Wallet débanni.', () => adminPost('/api/admin/unban', { wallet: w }));
          },
        }, 'Débannir'),
      ),
    ),
  );
}

function resizeTool(): HTMLElement {
  const w = canvas?.width ?? config!.width;
  const hgt = canvas?.height ?? config!.height;
  const [fw, iw] = numberField('largeur', w, w, MAX_CANVAS_SIZE);
  const [fh, ih] = numberField('hauteur', hgt, hgt, MAX_CANVAS_SIZE);
  const form = h(
    'form',
    { class: 'form' },
    h('p', { class: 'small muted' }, `Taille actuelle ${w}×${hgt}. Agrandissement seulement (max ${MAX_CANVAS_SIZE}), le contenu reste en haut à gauche.`),
    h('div', { class: 'grid-2' }, fw, fh),
    h('button', { class: 'btn', type: 'submit' }, 'Agrandir la toile'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const size = { width: Number(iw.value), height: Number(ih.value) };
    if (confirm(`Passer la toile en ${size.width}×${size.height} ?`)) void run('Toile agrandie.', () => adminPost('/api/admin/resize', size));
  });
  return tool('Redimensionner', form);
}

void loadAll();
