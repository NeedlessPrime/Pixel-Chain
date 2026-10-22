import { type MeInfo } from '@pixel/shared';
import { fmtAmount } from '../format';
import { errorMessage } from '../messages';
import {
  isMobileDevice,
  onWalletsChanged,
  walletBrowserLinks,
  walletChoices,
  type Session,
  type SignedIn,
  type WalletChoice,
} from '../wallet';
import { add, h, setChildren } from './dom';
import { openModal } from './modal';
import { toast } from './toast';

const INSTALL_LINKS = [
  { name: 'Phantom', href: 'https://phantom.com/download' },
  { name: 'Solflare', href: 'https://solflare.com/download' },
  { name: 'Backpack', href: 'https://backpack.app/download' },
];

/** Wallet picker: detected wallets (live list), dev wallet in mock mode, mobile deep links. */
export function openWalletPicker(mock: boolean, onSignedIn: (s: SignedIn) => void): void {
  let busy = false;
  const list = h('div', { class: 'wallet-list' });
  const status = h('p', { class: 'wallet-status', role: 'status' });
  const modal = openModal('Connecter un wallet', { onClose: () => off() });
  modal.body.append(
    h('p', { class: 'muted' }, 'Une seule signature gratuite pour prouver que le wallet est à toi. Aucune transaction, aucun frais.'),
    list,
    status,
  );

  const render = () => {
    const choices = walletChoices(mock);
    const real = choices.filter((c) => c.id !== 'dev');
    const items: Node[] = choices.map((choice) => walletButton(choice));
    if (real.length === 0) items.unshift(noWallet());
    setChildren(list, items);
  };
  const off = onWalletsChanged(render);
  render();

  function walletButton(choice: WalletChoice): HTMLElement {
    return h(
      'button',
      {
        class: 'wallet-option',
        type: 'button',
        onclick: async () => {
          if (busy) return;
          busy = true;
          list.classList.add('is-busy');
          status.className = 'wallet-status';
          status.textContent = `Valide la signature dans ${choice.name}…`;
          try {
            const signed = await choice.signIn();
            modal.close();
            onSignedIn(signed);
          } catch (err) {
            status.className = 'wallet-status is-error';
            status.textContent = errorMessage(err);
          } finally {
            busy = false;
            list.classList.remove('is-busy');
          }
        },
      },
      choice.icon
        ? h('img', { class: 'wallet-icon', src: choice.icon, alt: '', width: 32, height: 32 })
        : h('span', { class: 'wallet-icon wallet-icon-dev', 'aria-hidden': 'true' }, '⚙'),
      h(
        'span',
        { class: 'wallet-name' },
        choice.name,
        choice.detail ? h('small', { class: 'muted' }, choice.detail) : null,
      ),
    );
  }

  function noWallet(): HTMLElement {
    if (isMobileDevice()) {
      return h(
        'div',
        { class: 'wallet-empty' },
        h('p', null, 'Aucun wallet ici. Ouvre $PIXEL dans le navigateur de ton wallet :'),
        h('div', { class: 'wallet-links' }, walletBrowserLinks().map((l) => h('a', { class: 'btn btn-block', href: l.href }, `Ouvrir dans ${l.name}`))),
      );
    }
    return h(
      'div',
      { class: 'wallet-empty' },
      h('p', null, 'Aucun wallet Solana détecté. Installe l’extension, puis recharge la page :'),
      h('div', { class: 'wallet-links' }, INSTALL_LINKS.map((l) => h('a', { class: 'btn', href: l.href, target: '_blank', rel: 'noopener' }, l.name))),
    );
  }
}

/** Signed-in menu: address, balance, sign out. */
export function openAccountMenu(session: Session, me: MeInfo | null, symbol: string, onSignOut: () => void): void {
  const modal = openModal('Mon wallet');
  const copy = h('button', { class: 'btn btn-sm', type: 'button' }, 'Copier');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(session.wallet);
      toast('Adresse copiée', 'success');
    } catch {
      toast('Copie impossible', 'error');
    }
  });
  add(
    modal.body,
    h('div', { class: 'address-row' }, h('code', { class: 'address' }, session.wallet), copy),
    me ? h('p', null, `Solde : ${fmtAmount(me.balance)} ${symbol}${me.tier ? ` · palier ${me.tier.label}` : ''}`) : null,
    h(
      'button',
      {
        class: 'btn btn-block btn-danger',
        type: 'button',
        onclick: () => {
          modal.close();
          onSignOut();
        },
      },
      'Se déconnecter',
    ),
  );
}
