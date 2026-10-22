import './style.css';
import './hall.css';
import { EMPTY_COLOR, PALETTE, decodeTimelapse, shortWallet, type SeasonArchive } from '@pixel/shared';
import { api } from './api';
import { fmtDate, fmtInt } from './format';
import { errorMessage } from './messages';
import { TimelapsePlayer, type Speed } from './timelapse-player';
import { $, h, setChildren, setText } from './ui/dom';
import { logo } from './ui/logo';

const app = $('#app');
let seasons: SeasonArchive[] = [];
let player: TimelapsePlayer | null = null;

setChildren(
  $('#header'),
  logo(),
  h('nav', { class: 'site-nav' }, h('a', { class: 'btn btn-accent', href: '/' }, 'Jouer')),
);

function dates(s: SeasonArchive): string {
  return `du ${fmtDate(s.startedAt)} au ${fmtDate(s.endedAt)}`;
}

function seasonImage(s: SeasonArchive, className: string): HTMLImageElement {
  return h('img', {
    class: className,
    src: s.imageUrl,
    alt: `Toile finale de la saison ${s.number} : ${s.theme}`,
    width: s.width,
    height: s.height,
    loading: 'lazy',
    decoding: 'async',
  });
}

function podium(title: string, rows: { name: string; value: string }[]): HTMLElement | null {
  if (!rows.length) return null;
  return h(
    'div',
    { class: 'podium' },
    h('h3', { class: 'podium-title' }, title),
    h('ol', { class: 'podium-list' }, rows.map((r) => h('li', null, h('span', { class: 'podium-name' }, r.name), h('span', { class: 'muted' }, r.value)))),
  );
}

function topFactions(s: SeasonArchive, n: number) {
  return s.topFactions.slice(0, n).map((f) => ({ name: f.faction, value: `${fmtInt(f.pixels)} px` }));
}

function topPlayers(s: SeasonArchive, n: number) {
  return s.topPlayers.slice(0, n).map((p) => ({ name: shortWallet(p.wallet), value: `${fmtInt(p.pixels)} px` }));
}

/* ---------------- grid ---------------- */

function renderGrid(): void {
  document.title = 'Hall of Fame — $PIXEL';
  const intro = h(
    'div',
    { class: 'hall-intro' },
    h('h1', { class: 'page-title' }, 'Hall of Fame'),
    h('p', { class: 'muted' }, 'Chaque semaine, la toile est figée, signée du logo $PIXEL et rejoint cette galerie.'),
  );
  if (!seasons.length) {
    setChildren(app, intro, h('div', { class: 'empty card' }, h('p', null, 'Aucune saison terminée pour l’instant. La première arrive bientôt !'), h('a', { class: 'btn btn-accent', href: '/' }, 'Poser mes pixels')));
    return;
  }
  setChildren(
    app,
    intro,
    h(
      'div',
      { class: 'season-grid' },
      seasons.map((s) =>
        h(
          'a',
          { class: 'season-card card', href: `#${s.id}` },
          h('div', { class: 'season-thumb' }, seasonImage(s, 'pixelated')),
          h(
            'div',
            { class: 'season-card-body' },
            h('span', { class: 'season-num' }, `Saison ${s.number}`),
            h('h2', { class: 'season-theme' }, s.theme),
            h('p', { class: 'muted small' }, dates(s)),
            h('p', { class: 'small' }, `${fmtInt(s.totalPlacements)} pixels · ${fmtInt(s.uniquePlayers)} joueurs`),
            h('div', { class: 'podiums' }, podium('Factions', topFactions(s, 3)), podium('Joueurs', topPlayers(s, 3))),
          ),
        ),
      ),
    ),
  );
}

/* ---------------- season detail ---------------- */

function renderDetail(s: SeasonArchive): void {
  document.title = `Saison ${s.number} — Hall of Fame $PIXEL`;
  // Fit the stage in 75% of the viewport height whatever the board's proportions.
  const stage = h(
    'div',
    { class: 'player-stage', style: `aspect-ratio:${s.width}/${s.height};max-width:min(100%, ${(75 * s.width) / s.height}vh)` },
    seasonImage(s, 'pixelated'),
  );
  const controls = h('div', { class: 'player-controls' }, h('p', { class: 'muted small' }, 'Chargement du timelapse…'));

  setChildren(
    app,
    h('a', { class: 'back-link', href: '#' }, '← Toutes les saisons'),
    h(
      'header',
      { class: 'detail-head' },
      h('span', { class: 'season-num' }, `Saison ${s.number}`),
      h('h1', { class: 'page-title' }, s.theme),
      h('p', { class: 'muted' }, `${dates(s)} · ${fmtInt(s.totalPlacements)} pixels · ${fmtInt(s.uniquePlayers)} joueurs · ${s.width}×${s.height}`),
    ),
    h(
      'div',
      { class: 'detail-grid' },
      h(
        'section',
        { class: 'player card' },
        stage,
        controls,
        h('a', { class: 'btn btn-block', href: s.imageUrl, download: `pixel-saison-${s.number}.png` }, 'Télécharger l’image'),
      ),
      h(
        'aside',
        { class: 'detail-side card' },
        podium('Top factions', topFactions(s, 10)) ?? h('p', { class: 'muted' }, 'Aucune faction cette saison.'),
        podium('Top joueurs', topPlayers(s, 10)),
      ),
    ),
  );
  void loadTimelapse(s, stage, controls);
}

async function loadTimelapse(s: SeasonArchive, stage: HTMLElement, controls: HTMLElement): Promise<void> {
  let bytes: Uint8Array;
  try {
    const res = await fetch(s.timelapseUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    setChildren(controls, h('p', { class: 'muted small' }, 'Timelapse indisponible.'));
    return;
  }
  if (location.hash.slice(1) !== s.id) return; // navigated away meanwhile

  let tl;
  try {
    tl = decodeTimelapse(bytes);
  } catch {
    setChildren(controls, h('p', { class: 'muted small' }, 'Timelapse illisible.'));
    return;
  }

  const playBtn = h('button', { class: 'btn btn-accent play-btn', type: 'button', 'aria-label': 'Lecture' }, '▶');
  const scrubber = h('input', { class: 'scrubber', type: 'range', min: '0', max: String(tl.count), step: '1', 'aria-label': 'Position dans le timelapse' });
  const progress = h('span', { class: 'player-progress' });
  const speeds: Speed[] = [1, 4, 16, 'max'];
  const speedBtns = speeds.map((sp) =>
    h('button', { class: 'chip', type: 'button', onclick: () => setSpeed(sp) }, sp === 'max' ? 'max' : `×${sp}`),
  );

  player?.destroy();
  const p = new TimelapsePlayer(tl, PALETTE, EMPTY_COLOR, (st) => {
    playBtn.textContent = st.playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', st.playing ? 'Pause' : 'Lecture');
    scrubber.value = String(st.position);
    setText(progress, `${fmtInt(st.position)} / ${fmtInt(st.count)}`);
  });
  player = p;
  p.canvas.className = 'pixelated';
  p.canvas.setAttribute('aria-label', `Timelapse de la saison ${s.number}`);
  setChildren(stage, p.canvas);

  function setSpeed(sp: Speed): void {
    p.setSpeed(sp);
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(speeds[i] === sp)));
  }
  setSpeed(4);

  playBtn.addEventListener('click', () => p.toggle());
  scrubber.addEventListener('pointerdown', () => p.pause());
  scrubber.addEventListener('input', () => p.seek(Number(scrubber.value)));

  setChildren(
    controls,
    h('div', { class: 'player-row' }, playBtn, h('div', { class: 'chips', role: 'group', 'aria-label': 'Vitesse' }, speedBtns), progress),
    scrubber,
  );
}

/* ---------------- routing ---------------- */

function route(): void {
  player?.destroy();
  player = null;
  const id = location.hash.slice(1);
  const season = id ? seasons.find((s) => s.id === id) : undefined;
  if (season) renderDetail(season);
  else renderGrid();
  window.scrollTo(0, 0);
}

async function boot(): Promise<void> {
  setChildren(app, h('p', { class: 'muted' }, 'Chargement du Hall of Fame…'));
  try {
    seasons = await api.seasons();
  } catch (err) {
    setChildren(app, h('div', { class: 'empty card' }, h('p', null, errorMessage(err)), h('button', { class: 'btn', type: 'button', onclick: () => void boot() }, 'Réessayer')));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

void boot();
