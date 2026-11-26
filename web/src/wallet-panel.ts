/**
 * The parts of the wallet page that are about having more than one wallet:
 * the card of the wallet in use (its name and icon, its address as a QR
 * code), the list of wallets with making, importing, switching and removing,
 * and the address book.
 *
 * Nothing here moves funds. Switching wallets changes which key every page
 * signs with; everything else changes only what this browser remembers.
 */

import { PublicKey } from '@solana/web3.js';

import { WALLET_ICONS } from '../../shared/src/keyring.js';
import { isRegistered } from '../../shared/src/privacy.js';
import { connection, publicLamports, ringsClient } from './chain.js';
import { sol } from './format.js';
import { qrSvg } from './qr.js';
import { paintIdentity } from './shell.js';
import { byId, describeError, deterministicAvatar, escapeHtml, short, toast, wireCopyButtons } from './ui.js';
import { iconSvg } from './wallet-icons.js';
import {
  type Session,
  type WalletInfo,
  createWallet,
  findWallets,
  importWallet,
  keyringOpen,
  listContacts,
  listWallets,
  removeContact,
  removeWallet,
  removedWallets,
  renameWallet,
  restoreWallet,
  saveContact,
  setWalletIcon,
  useWallet,
  walletSecret,
} from './wallet.js';

export interface WalletPanelOptions {
  session(): Session | null;
  /** True while the page is in the middle of something that must not be interrupted by a switch. */
  busy(): boolean;
  /** The wallet in use changed: the page reads everything again for the new one. */
  onSwitch(session: Session): Promise<void>;
  /** Names, icons or contacts changed: whatever shows them is drawn again. */
  onChange(): void;
  /** Somebody pressed Send on a contact. */
  onPick(address: string): void;
}

export interface WalletPanel {
  render(): void;
  /** Buttons that put an address into a recipient field: the other wallets on the list, then the contacts. */
  picksHtml(): string;
}

/** A wallet's or a contact's icon. `auto`, and anything unknown, is the pixel mark of its address. */
export function iconHtml(icon: string, address: string, name: string): string {
  return iconSvg(icon, name, deterministicAvatar(address));
}

const KIND_LABEL: Record<WalletInfo['kind'], string> = { root: 'First wallet', derived: 'Made from your first wallet', imported: 'Imported' };
const REMOVE_WORD = 'REMOVE';

export function mountWalletPanel(options: WalletPanelOptions): WalletPanel {
  const output = (id: string, kind: 'working' | 'ok' | 'error', title: string, body = ''): void => {
    byId(id).innerHTML = `<div class="status ${kind === 'working' ? '' : kind}"><b>${escapeHtml(title)}</b>${body ? `<br>${body}` : ''}</div>`;
  };
  /** One thing at a time here too: a second press while a switch is under way is ignored. */
  let working = false;
  const free = (): boolean => !working && !options.busy();

  const ghost = (): boolean => options.session()?.kind === 'ghost' && keyringOpen();
  const activeInfo = (): WalletInfo | undefined => listWallets().find((wallet) => wallet.active);

  async function switchTo(run: () => Promise<Session>, done: string): Promise<void> {
    if (!free()) return;
    working = true;
    try {
      const session = await run();
      byId('wallets-output').innerHTML = '';
      closeForms();
      await options.onSwitch(session);
      toast(done);
    } catch (error) {
      // A wallet that turned out not to open is shown as such from here on.
      renderWallets();
      output('wallets-output', 'error', 'NOT DONE', escapeHtml(describeError(error)));
    } finally {
      working = false;
    }
  }

  function closeForms(): void {
    for (const id of ['wallet-new-form', 'wallet-import-form', 'w-rename-form', 'w-icons']) byId(id).hidden = true;
  }

  /* ---------------- The card of the wallet in use ---------------- */

  function renderCard(): void {
    const session = options.session();
    if (!session) return;
    const info = ghost() ? activeInfo() : undefined;
    const name = info?.name ?? session.label;
    byId('w-name').textContent = name;
    byId('w-kind').textContent = info ? KIND_LABEL[info.kind] : session.kind === 'external' ? 'Wallet extension · beta' : 'Ghost wallet';
    byId('w-icon').innerHTML = iconHtml(info?.icon ?? 'auto', session.address, name);
    byId<HTMLButtonElement>('w-icon').disabled = !info;
    byId('w-rename').hidden = !info;
    if (!info) {
      byId('w-rename-form').hidden = true;
      byId('w-icons').hidden = true;
    }
    if (!byId('receive-panel').hidden) byId('receive-qr').innerHTML = qrSvg(session.address);
    if (!byId('w-icons').hidden) renderIconGrid();
  }

  function renderIconGrid(): void {
    const info = activeInfo();
    if (!info) return;
    const grid = byId('w-icon-grid');
    grid.innerHTML = WALLET_ICONS.map(
      (icon) => `<button type="button" data-icon="${escapeHtml(icon)}" class="${icon === info.icon ? 'on' : ''}" aria-label="${icon === 'auto' ? 'The pixel mark of this address' : escapeHtml(icon)}" title="${icon === 'auto' ? 'Automatic' : escapeHtml(icon)}">${iconHtml(icon, info.address, icon)}</button>`,
    ).join('');
    grid.querySelectorAll<HTMLButtonElement>('[data-icon]').forEach((button) => {
      button.addEventListener('click', () => {
        try {
          setWalletIcon(info.address, button.dataset.icon ?? 'auto');
          render();
          options.onChange();
        } catch (error) {
          toast(describeError(error), 'error');
        }
      });
    });
  }

  byId('w-icon').addEventListener('click', () => {
    if (!ghost()) return;
    const panel = byId('w-icons');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderIconGrid();
  });

  byId('w-rename').addEventListener('click', () => {
    const form = byId('w-rename-form');
    form.hidden = !form.hidden;
    if (!form.hidden) {
      const input = byId<HTMLInputElement>('w-rename-input');
      input.value = activeInfo()?.name ?? '';
      input.focus();
      input.select();
    }
  });

  byId<HTMLFormElement>('w-rename-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const info = activeInfo();
    if (!info) return;
    try {
      renameWallet(info.address, byId<HTMLInputElement>('w-rename-input').value);
      byId('w-rename-form').hidden = true;
      render();
      options.onChange();
      toast('Renamed');
    } catch (error) {
      toast(describeError(error), 'error');
    }
  });

  byId('w-receive').addEventListener('click', () => {
    const session = options.session();
    if (!session) return;
    const panel = byId('receive-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) byId('receive-qr').innerHTML = qrSvg(session.address);
  });
  byId('receive-hide').addEventListener('click', () => {
    byId('receive-panel').hidden = true;
  });

  /* ---------------- The list of wallets ---------------- */

  let balanceRound = 0;

  async function fillBalances(wallets: readonly WalletInfo[]): Promise<void> {
    const round = ++balanceRound;
    try {
      const accounts = await connection().getMultipleAccountsInfo(wallets.map((wallet) => new PublicKey(wallet.address)), 'confirmed');
      if (round !== balanceRound) return;
      wallets.forEach((wallet, index) => {
        const node = document.querySelector<HTMLElement>(`[data-balance="${wallet.address}"]`);
        if (node) node.textContent = `Public SOL: ${sol(BigInt(accounts[index]?.lamports ?? 0), 4)}`;
      });
    } catch {
      if (round !== balanceRound) return;
      document.querySelectorAll<HTMLElement>('[data-balance]').forEach((node) => {
        node.textContent = 'Public SOL: not read';
      });
    }
  }

  function renderWallets(): void {
    const section = byId('wallets-section');
    section.hidden = !ghost();
    byId('contacts-section').hidden = !ghost();
    if (section.hidden) return;
    const wallets = listWallets();
    const grid = byId('wallets-grid');
    grid.innerHTML = wallets
      .map((wallet) => {
        const address = escapeHtml(wallet.address);
        const use = wallet.active
          ? '<span class="wallet-tag">In use</span>'
          : wallet.usable
            ? `<button class="btn flat" type="button" data-use="${address}">Use</button>`
            : '<span class="wallet-tag">Could not be opened</span>';
        const key = wallet.usable ? `<button class="btn flat" type="button" data-key="${address}">Secret key</button>` : '';
        const remove = wallet.kind === 'root' ? '' : `<button class="btn flat" type="button" data-remove="${address}">Remove</button>`;
        return `<article class="wallet-tile${wallet.active ? ' is-active' : ''}"><div class="wallet-tile-head"><span class="wallet-icon is-small">${iconHtml(wallet.icon, wallet.address, wallet.name)}</span><div><b>${escapeHtml(wallet.name)}</b><small>${escapeHtml(short(wallet.address, 4, 4))} · ${KIND_LABEL[wallet.kind]}</small></div></div><small data-balance="${address}">Public SOL: …</small><div class="row-wrap">${use}${key}${remove}</div></article>`;
      })
      .join('');
    grid.querySelectorAll<HTMLButtonElement>('[data-use]').forEach((button) => {
      button.addEventListener('click', () => void switchTo(() => useWallet(button.dataset.use ?? ''), 'Wallet switched'));
    });
    grid.querySelectorAll<HTMLButtonElement>('[data-key]').forEach((button) => {
      button.addEventListener('click', () => void showSecret(button.dataset.key ?? ''));
    });
    grid.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => askRemove(button.dataset.remove ?? ''));
    });
    void fillBalances(wallets);

    const removed = removedWallets();
    const list = byId('wallets-removed');
    list.innerHTML = removed.length
      ? `<p class="small muted" style="margin:18px 0 8px">Taken off the list. Each still exists and can be put back:</p><div class="row-wrap" style="margin-top:0">${removed
          .map((wallet) => `<button class="btn flat" type="button" data-restore="${escapeHtml(wallet.address)}">Put back ${escapeHtml(wallet.name)} · ${escapeHtml(short(wallet.address, 4, 4))}</button>`)
          .join('')}</div>`
      : '';
    list.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((button) => {
      button.addEventListener('click', () => {
        try {
          restoreWallet(button.dataset.restore ?? '');
          render();
          options.onChange();
        } catch (error) {
          output('wallets-output', 'error', 'NOT DONE', escapeHtml(describeError(error)));
        }
      });
    });
  }

  async function showSecret(address: string): Promise<void> {
    const wallet = listWallets().find((candidate) => candidate.address === address);
    if (!wallet) return;
    try {
      const secret = await walletSecret(address);
      byId('wallets-output').innerHTML = `<div class="status"><b>SECRET KEY OF ${escapeHtml(wallet.name.toUpperCase())}</b><br>Anyone who has it controls this wallet. Click to reveal.<div class="secret-box" id="wallet-secret" title="Click to reveal" style="margin-top:12px">${escapeHtml(secret)}</div><div class="row-wrap" style="margin-top:12px"><button class="btn flat" type="button" data-copy data-copy-target="#wallet-secret">Copy secret key</button><button class="btn flat" type="button" id="wallet-secret-hide">Hide</button></div></div>`;
      const box = byId('wallet-secret');
      box.addEventListener('click', () => box.classList.add('is-shown'));
      byId('wallet-secret-hide').addEventListener('click', () => {
        byId('wallets-output').innerHTML = '';
      });
      wireCopyButtons(byId('wallets-output'));
      byId('wallets-output').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      output('wallets-output', 'error', 'NOT SHOWN', escapeHtml(describeError(error)));
    }
  }

  function askRemove(address: string): void {
    const wallet = listWallets().find((candidate) => candidate.address === address);
    if (!wallet || wallet.kind === 'root') return;
    const name = escapeHtml(wallet.name);
    const body =
      wallet.kind === 'derived'
        ? `Its key can always be made again from your first wallet, and it can be put back from under this list. Whatever it holds stays where it is, on chain.<div class="row-wrap" style="margin-top:12px"><button class="btn" type="button" id="wallet-remove-go">Take it off the list</button><button class="btn flat" type="button" id="wallet-remove-no">Keep it</button></div>`
        : `This deletes its saved key from this browser. Your first wallet's backup does not cover it: without its own secret key it cannot be brought back, and whatever it holds would be out of reach. Save its secret key first.<form class="inline-form" id="wallet-remove-form" novalidate style="margin-top:12px"><label class="field" style="margin:0"><span>Type ${REMOVE_WORD} to delete it</span><input id="wallet-remove-word" autocomplete="off" autocapitalize="characters" spellcheck="false"></label><button class="btn" type="submit">Delete</button><button class="btn flat" type="button" id="wallet-remove-no">Keep it</button></form>`;
    byId('wallets-output').innerHTML = `<div class="status error"><b>REMOVE ${name.toUpperCase()}?</b><br>${body}</div>`;
    const go = async (): Promise<void> => {
      if (!free()) return;
      working = true;
      try {
        const next = await removeWallet(address);
        byId('wallets-output').innerHTML = '';
        if (next) await options.onSwitch(next);
        else {
          render();
          options.onChange();
        }
        toast('Removed from the list');
      } catch (error) {
        output('wallets-output', 'error', 'NOT REMOVED', escapeHtml(describeError(error)));
      } finally {
        working = false;
      }
    };
    document.getElementById('wallet-remove-go')?.addEventListener('click', () => void go());
    document.getElementById('wallet-remove-no')?.addEventListener('click', () => {
      byId('wallets-output').innerHTML = '';
    });
    document.getElementById('wallet-remove-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (byId<HTMLInputElement>('wallet-remove-word').value.trim().toUpperCase() !== REMOVE_WORD) {
        toast(`Type ${REMOVE_WORD} to confirm.`, 'error');
        return;
      }
      void go();
    });
    byId('wallets-output').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  byId('wallet-new').addEventListener('click', () => {
    const form = byId('wallet-new-form');
    const open = form.hidden;
    closeForms();
    form.hidden = !open;
    if (open) byId<HTMLInputElement>('wallet-new-name').focus();
  });
  byId('wallet-import').addEventListener('click', () => {
    const form = byId('wallet-import-form');
    const open = form.hidden;
    closeForms();
    form.hidden = !open;
    if (open) byId<HTMLTextAreaElement>('wallet-import-secret').focus();
  });

  byId<HTMLFormElement>('wallet-new-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = byId<HTMLInputElement>('wallet-new-name');
    const name = input.value.trim();
    void switchTo(() => createWallet(name || undefined), 'New wallet in use').then(() => {
      if (byId('wallet-new-form').hidden) input.value = '';
    });
  });

  byId<HTMLFormElement>('wallet-import-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const secret = byId<HTMLTextAreaElement>('wallet-import-secret');
    const name = byId<HTMLInputElement>('wallet-import-name');
    void switchTo(() => importWallet(secret.value, name.value.trim() || undefined), 'Imported wallet in use').then(() => {
      // The pasted key stays on screen only while it is still needed to try again.
      if (byId('wallet-import-form').hidden) {
        secret.value = '';
        name.value = '';
      }
    });
  });

  byId('wallet-find').addEventListener('click', async () => {
    if (!free()) return;
    working = true;
    output('wallets-output', 'working', 'LOOKING', 'Asking the chain about the wallets this first wallet can make…');
    try {
      const client = await ringsClient();
      const found = await findWallets(async (candidate) => {
        // Anything that ever happened at an address left a transaction behind: SOL coming in, a registration, a shield.
        try {
          if ((await connection().getSignaturesForAddress(new PublicKey(candidate), { limit: 1 }, 'confirmed')).length > 0) return true;
        } catch {
          // Without the history, what the address holds now still says something.
        }
        return (await publicLamports(candidate)) > 0n || (await isRegistered(client, candidate));
      });
      output(
        'wallets-output',
        'ok',
        found > 0 ? `FOUND ${found}` : 'NOTHING MORE',
        found > 0
          ? 'Added to the list. A wallet is found when anything has ever happened at its address.'
          : 'Nothing has ever happened at the next wallets this first wallet can make. New wallet makes the lowest-numbered one that is not on the list yet.',
      );
      render();
      options.onChange();
    } catch (error) {
      output('wallets-output', 'error', 'COULD NOT LOOK', escapeHtml(describeError(error)));
    } finally {
      working = false;
    }
  });

  /* ---------------- Contacts ---------------- */

  function renderContacts(): void {
    if (!ghost()) return;
    const contacts = listContacts();
    const list = byId('contacts-list');
    list.innerHTML = contacts.length
      ? contacts
          .map(
            (contact) =>
              `<div class="contact-row"><span class="wallet-icon is-small">${iconHtml(contact.icon, contact.address, contact.name)}</span><div><b>${escapeHtml(contact.name)}</b><small>${escapeHtml(contact.address)}</small></div><div class="row-wrap" style="margin-top:0"><button class="btn flat" type="button" data-contact-send="${escapeHtml(contact.address)}">Send</button><button class="btn flat" type="button" data-contact-remove="${escapeHtml(contact.address)}">Remove</button></div></div>`,
          )
          .join('')
      : '<div class="empty-state">NO CONTACTS YET<br><br>Save an address with a name and it is offered whenever you send.</div>';
    list.querySelectorAll<HTMLButtonElement>('[data-contact-send]').forEach((button) => {
      button.addEventListener('click', () => options.onPick(button.dataset.contactSend ?? ''));
    });
    list.querySelectorAll<HTMLButtonElement>('[data-contact-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        try {
          removeContact(button.dataset.contactRemove ?? '');
          render();
          options.onChange();
        } catch (error) {
          toast(describeError(error), 'error');
        }
      });
    });
  }

  byId<HTMLFormElement>('contact-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = byId<HTMLInputElement>('contact-name');
    const address = byId<HTMLInputElement>('contact-address');
    try {
      saveContact(address.value.trim(), name.value);
      name.value = '';
      address.value = '';
      byId('contacts-output').innerHTML = '';
      render();
      options.onChange();
      toast('Contact saved');
    } catch (error) {
      output('contacts-output', 'error', 'NOT SAVED', escapeHtml(describeError(error)));
    }
  });

  function render(): void {
    renderCard();
    renderWallets();
    renderContacts();
    paintIdentity();
  }

  function picksHtml(): string {
    if (!ghost()) return '';
    const own = listWallets()
      .filter((wallet) => !wallet.active)
      .map((wallet) => ({ address: wallet.address as string, name: wallet.name, icon: wallet.icon }));
    return [...own, ...listContacts()]
      .map((entry) => `<button type="button" data-pick="${escapeHtml(entry.address)}"><span class="wallet-icon is-tiny">${iconHtml(entry.icon, entry.address, entry.name)}</span>${escapeHtml(entry.name)}</button>`)
      .join('');
  }

  return { render, picksHtml };
}
