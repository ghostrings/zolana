/**
 * The docs: which pages there are, in what order, and under which heading of
 * the sidebar. The words are in `pages/*.md`.
 */

import addresses from './pages/addresses.md?raw';
import alerts from './pages/alerts.md?raw';
import burning from './pages/burning.md?raw';
import buyAnyToken from './pages/buy-any-token.md?raw';
import checkUp from './pages/check-up.md?raw';
import converting from './pages/converting.md?raw';
import customRings from './pages/custom-rings.md?raw';
import depositWithdraw from './pages/deposit-withdraw.md?raw';
import externalWallets from './pages/external-wallets.md?raw';
import faq from './pages/faq.md?raw';
import feeModules from './pages/fee-modules.md?raw';
import fees from './pages/fees.md?raw';
import ghostDesk from './pages/ghost-desk.md?raw';
import ghostWallet from './pages/ghost-wallet.md?raw';
import graduation from './pages/graduation.md?raw';
import keyIdeas from './pages/key-ideas.md?raw';
import keysAndProofs from './pages/keys-and-proofs.md?raw';
import launching from './pages/launching.md?raw';
import limits from './pages/limits.md?raw';
import market from './pages/market.md?raw';
import pairs from './pages/pairs.md?raw';
import payMany from './pages/pay-many.md?raw';
import paymentRequests from './pages/payment-requests.md?raw';
import privateBalance from './pages/private-balance.md?raw';
import privateTransfers from './pages/private-transfers.md?raw';
import prvmax from './pages/prvmax.md?raw';
import quickstart from './pages/quickstart.md?raw';
import readOnlyAccess from './pages/read-only-access.md?raw';
import rewards from './pages/rewards.md?raw';
import ringsExplorer from './pages/rings-explorer.md?raw';
import risks from './pages/risks.md?raw';
import statements from './pages/statements.md?raw';
import trading from './pages/trading.md?raw';
import troubleshooting from './pages/troubleshooting.md?raw';
import wallets from './pages/wallets.md?raw';
import welcome from './pages/welcome.md?raw';
import whatIsPrivate from './pages/what-is-private.md?raw';

export interface DocPage {
  /** The last part of the page's address: /docs/<slug>. The first page is also /docs itself. */
  readonly slug: string;
  readonly title: string;
  /** One line under the title, and what search shows for the page. */
  readonly summary: string;
  readonly body: string;
}

export interface DocGroup {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

export const DOC_GROUPS: readonly DocGroup[] = Object.freeze([
  {
    title: 'Start here',
    pages: [
      { slug: 'welcome', title: 'Welcome', summary: 'What this site is, and the one rule to remember about it.', body: welcome },
      { slug: 'quickstart', title: 'Quickstart', summary: 'From nothing to a private balance, in six steps.', body: quickstart },
      { slug: 'key-ideas', title: 'Key ideas', summary: 'The dozen words every other page leans on.', body: keyIdeas },
    ],
  },
  {
    title: 'Wallet',
    pages: [
      { slug: 'ghost-wallet', title: 'The ghost wallet', summary: 'The wallet built into this site: how it is made, kept and backed up.', body: ghostWallet },
      { slug: 'wallets', title: 'Several wallets', summary: 'More than one wallet under one passphrase: making, naming, switching, backing up and sending between them.', body: wallets },
      { slug: 'external-wallets', title: 'Your own wallet', summary: 'Using a wallet extension instead, and what changes when you do.', body: externalWallets },
      { slug: 'private-balance', title: 'Private balance', summary: 'How it is read, why it fragments, and what "Not read" means.', body: privateBalance },
      { slug: 'deposit-withdraw', title: 'Shield and unshield', summary: 'The two public crossings between your balances: a deposit into Rings and a withdrawal from it.', body: depositWithdraw },
      { slug: 'payment-requests', title: 'Ask for a payment', summary: 'A link that fills in Send for whoever pays you: your address, the token, the amount and a note.', body: paymentRequests },
      { slug: 'pay-many', title: 'Pay many', summary: 'Pay a list of wallets from your private balance in one run, with a receipt, and never the same wallet twice.', body: payMany },
      { slug: 'statements', title: 'Statements', summary: 'Your private history for a period as a file, put together in your browser.', body: statements },
      { slug: 'alerts', title: 'Alerts', summary: 'Have this browser tell you when something arrives, without telling anyone that you are watching.', body: alerts },
      { slug: 'prvmax', title: 'prvmax: vaults', summary: 'Up to ten vaults behind one wallet: spread, trade, recall, and what stays public.', body: prvmax },
    ],
  },
  {
    title: 'Tokens',
    pages: [
      { slug: 'market', title: 'The market', summary: 'Cards, a grid or a table: ordering, searching and what a card shows.', body: market },
      { slug: 'trading', title: 'Trading', summary: 'Three routes to the pool, and what each one shows the chain.', body: trading },
      { slug: 'private-transfers', title: 'Send privately', summary: 'Move a token to another wallet without showing which token or how much.', body: privateTransfers },
      { slug: 'burning', title: 'Burn tokens', summary: 'Destroy tokens for good, straight out of a private balance.', body: burning },
      { slug: 'launching', title: 'Launch a token', summary: 'Three screens, one signature, and what becomes permanent.', body: launching },
      { slug: 'pairs', title: 'Pair tokens', summary: 'What a token is priced in: SOL, or another token, and what that changes.', body: pairs },
      { slug: 'converting', title: 'Pay with SOL or USDC', summary: 'Buying a token priced in something else, converted inside the same transaction.', body: converting },
      { slug: 'buy-any-token', title: 'Buy any token', summary: 'A token that was not launched here, bought through Jupiter into your private balance, and sold out of it.', body: buyAnyToken },
      { slug: 'graduation', title: 'Curve and graduation', summary: 'Where a token starts, where it ends up, and what stays the same.', body: graduation },
    ],
  },
  {
    title: 'Fees and rewards',
    pages: [
      { slug: 'fees', title: 'Fees', summary: 'One fee, fixed at launch, and exactly who is paid from it.', body: fees },
      { slug: 'rewards', title: 'Creator rewards', summary: 'What a creator earns, how it is claimed, and what is and is not enforced.', body: rewards },
      { slug: 'fee-modules', title: 'Fee modules', summary: 'Buyback and burn, and sharing fees between wallets, run automatically from a creator\'s fees.', body: feeModules },
    ],
  },
  {
    title: 'Privacy',
    pages: [
      { slug: 'what-is-private', title: 'What is private', summary: 'Every action on this site, and what the chain shows for it.', body: whatIsPrivate },
      { slug: 'ghost-desk', title: 'The Ghost desk', summary: 'Trading without touching the pool: what it hides and what the desk learns.', body: ghostDesk },
      { slug: 'rings-explorer', title: 'The Rings page', summary: 'What anyone can read of Rings: tokens held privately, what went in and out, and who paid whom.', body: ringsExplorer },
      { slug: 'custom-rings', title: 'Custom rings', summary: 'Rings run by a business, with their own rules and an auditor: what the list on the Rings page shows, and what it does not.', body: customRings },
      { slug: 'check-up', title: 'The check-up', summary: 'What your own public activity lets an onlooker work out, and what takes the guess away.', body: checkUp },
      { slug: 'read-only-access', title: 'Read-only access', summary: 'A viewing pass lets somebody read one wallet and move nothing. What it holds, and why it cannot be taken back.', body: readOnlyAccess },
      { slug: 'keys-and-proofs', title: 'Keys, proofs and the server', summary: 'Where your keys are, what runs in your browser, what the server sees.', body: keysAndProofs },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'addresses', title: 'Addresses', summary: 'Every program and account this site depends on, linked to an explorer.', body: addresses },
      { slug: 'limits', title: 'Limits and pauses', summary: 'What the operator can slow down, and what can never be held.', body: limits },
      { slug: 'troubleshooting', title: 'Troubleshooting', summary: 'What each message means and what to do about it.', body: troubleshooting },
      { slug: 'risks', title: 'Risks', summary: 'Read these before using the site with more than you can afford to lose.', body: risks },
      { slug: 'faq', title: 'FAQ', summary: 'Short answers to the questions that come up most.', body: faq },
    ],
  },
]);

/** Every page in reading order, each with the group it belongs to. */
export const DOC_PAGES: ReadonlyArray<DocPage & { readonly group: string }> = Object.freeze(
  DOC_GROUPS.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title }))),
);

/** The page a path under /docs asks for, or null when there is none. "/docs" and "/docs/" are the first page. */
export function pageForPath(pathname: string): (DocPage & { readonly group: string }) | null {
  const rest = pathname.replace(/^\/docs\/?/, '').replace(/\/+$/, '');
  if (pathname !== '/docs' && !pathname.startsWith('/docs/')) return null;
  if (!rest) return DOC_PAGES[0] ?? null;
  return DOC_PAGES.find((page) => page.slug === rest) ?? null;
}

/** The address of a page. The first one is the docs' own front door. */
export function pathForSlug(slug: string): string {
  return slug === DOC_PAGES[0]?.slug ? '/docs' : `/docs/${slug}`;
}
