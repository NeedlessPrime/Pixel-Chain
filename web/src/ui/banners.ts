import { onTick } from '../clock';
import { fmtCountdown } from '../format';
import type { GameActions, GameState, Store } from '../store';
import { h, setText } from './dom';

/** Strips under the top bar: frozen season and mock mode (with the fake balance input). */
export function mountBanners(root: HTMLElement, store: Store<GameState>, actions: GameActions): void {
  const frozenText = h('span');
  const frozen = h(
    'div',
    { class: 'banner banner-frozen', hidden: true, role: 'status' },
    frozenText,
    h('a', { class: 'banner-link', href: '/hall' }, 'Voir le Hall of Fame →'),
  );

  const balanceInput = h('input', {
    type: 'number',
    min: '0',
    step: '1000',
    inputMode: 'numeric',
    class: 'input input-sm',
    'aria-label': 'Solde fictif',
    placeholder: '100000',
  });
  const balanceForm = h(
    'form',
    {
      class: 'mock-form',
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        const value = Number(balanceInput.value);
        if (Number.isFinite(value) && value >= 0) void actions.setDevBalance(value);
      },
    },
    h('label', { class: 'hide-xs' }, 'Mon solde :'),
    balanceInput,
    h('button', { class: 'btn btn-sm', type: 'submit' }, 'OK'),
  );
  const mockHint = h('span', { class: 'mock-hint' }, 'connecte le « Dev wallet » pour jouer');
  const mock = h(
    'div',
    { class: 'banner banner-mock', hidden: true },
    h('strong', null, 'Mode test', h('span', { class: 'hide-xs mock-sub' }, ' : soldes fictifs')),
    balanceForm,
    mockHint,
  );

  root.append(frozen, mock);

  let lastBalance: number | null = null;
  store.subscribe((s) => {
    frozen.hidden = s.season?.status !== 'frozen';
    mock.hidden = s.config?.mode !== 'mock';
    balanceForm.hidden = !s.session;
    mockHint.hidden = !!s.session;
    // Mirror the server balance unless the player is editing the field.
    if (s.me && s.me.balance !== lastBalance && document.activeElement !== balanceInput) {
      balanceInput.value = String(s.me.balance);
      lastBalance = s.me.balance;
    }
  });

  onTick((now) => {
    const season = store.get().season;
    if (season?.status !== 'frozen') return;
    setText(
      frozenText,
      season.nextSeasonAt
        ? `Saison terminée — prochaine saison dans ${fmtCountdown(season.nextSeasonAt - now)}`
        : 'Saison terminée',
    );
  });
}
