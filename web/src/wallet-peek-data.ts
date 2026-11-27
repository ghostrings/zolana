/** Lazy-loaded wallet overview. No signing or transaction construction happens here. */
import { PublicKey } from '@solana/web3.js';
import { SOL_DECIMALS, TOKEN_DECIMALS, TOKEN_PROGRAM_ID } from '../../shared/src/constants.js';
import { SOL_MINT, privateBalance, privateHistory, privateHoldings } from '../../shared/src/privacy.js';
import { pairSymbol, pairTokenByMint } from '../../shared/src/quotes.js';
import { formatUnits, groupDigits } from '../../shared/src/units.js';
import { api } from './api.js';
import { connection, publicLamports } from './chain.js';
import { getSession } from './wallet.js';
import { short } from './ui.js';
import type { TokenSummary } from '../../shared/src/api.js';

export interface PeekAsset { mint: string; symbol: string; name: string; image: string; amount: string; source: 'private' | 'public' }
export interface PeekActivity { kind: string; direction: string; symbol: string; amount: string }
export interface PeekData { privateSol: string | null; publicSol: string | null; privateOk: boolean; publicOk: boolean; assets: PeekAsset[]; activity: PeekActivity[] }
const number = (amount: bigint, decimals: number) => groupDigits(formatUnits(amount, decimals, decimals));

export async function loadPeek(owner: string, catalog: readonly TokenSummary[]): Promise<PeekData> {
  const publicRead = async () => {
    const accounts = await connection().getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(TOKEN_PROGRAM_ID) });
    const map = new Map<string, { amount: bigint; decimals: number }>();
    for (const { account } of accounts.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      if (!info?.mint || info.tokenAmount?.decimals === undefined) continue;
      const amount = BigInt(info.tokenAmount.amount ?? '0');
      if (amount <= 0n) continue;
      const previous = map.get(info.mint);
      map.set(info.mint, { amount: (previous?.amount ?? 0n) + amount, decimals: info.tokenAmount.decimals });
    }
    return map;
  };
  const privateRead = async () => {
    const session = await getSession();
    if (!session || session.address !== owner) throw new Error('Wallet is not unlocked.');
    await session.sync();
    return { sol: privateBalance(session.ctx, SOL_MINT as typeof session.address), holdings: privateHoldings(session.ctx), history: privateHistory(session.ctx).slice(-15).reverse() };
  };
  const [solResult, publicResult, privateResult] = await Promise.allSettled([publicLamports(owner), publicRead(), privateRead()]);
  const pub = publicResult.status === 'fulfilled' ? publicResult.value : new Map<string, { amount: bigint; decimals: number }>();
  const priv = privateResult.status === 'fulfilled' ? privateResult.value : null;
  // Do not disclose the contents of private holdings to the listing endpoint.
  // Resolve private metadata from the public page already loaded; look up only public mints.
  const mints = [...pub.keys()].filter((mint) => mint !== SOL_MINT);
  const tokens = new Map<string, TokenSummary>(catalog.map((token) => [token.mint, token]));
  try { for (const token of await api.tokensByMints(mints)) tokens.set(token.mint, token); } catch { /* unknown assets retain their mint label */ }
  const metadata = (mint: string) => {
    const token = tokens.get(mint);
    const pair = pairTokenByMint(mint);
    return { symbol: mint === SOL_MINT ? 'SOL' : token?.symbol || (pair ? pairSymbol(pair) : short(mint)), name: mint === SOL_MINT ? 'Solana' : token?.name || pair?.name || 'Asset (mint)', image: token?.image ?? '' };
  };
  const decimals = new Map<string, number>([[SOL_MINT, SOL_DECIMALS]]);
  for (const [mint, value] of pub) decimals.set(mint, value.decimals);
  for (const [mint] of tokens) if (!decimals.has(mint)) decimals.set(mint, TOKEN_DECIMALS);
  try {
    for (const pair of (await api.status()).pairs) if (pair.problem === null) decimals.set(pair.mint, pair.decimals);
  } catch { /* unavailable pairs retain raw units */ }
  const formatted = (mint: string, raw: bigint) => {
    const places = decimals.get(mint);
    return places === undefined ? `${raw.toString()} base units` : number(raw, places);
  };
  const assets: PeekAsset[] = [];
  if (priv) for (const asset of priv.holdings) assets.push({ mint: asset.mint, ...metadata(asset.mint), amount: formatted(asset.mint, asset.amount), source: 'private' });
  if (solResult.status === 'fulfilled') assets.push({ mint: SOL_MINT, ...metadata(SOL_MINT), amount: number(solResult.value, SOL_DECIMALS), source: 'public' });
  for (const [mint, value] of pub) assets.push({ mint, ...metadata(mint), amount: formatted(mint, value.amount), source: 'public' });
  return {
    publicSol: solResult.status === 'fulfilled' ? number(solResult.value, SOL_DECIMALS) : null,
    privateSol: priv ? number(priv.sol, SOL_DECIMALS) : null,
    privateOk: priv !== null,
    publicOk: solResult.status === 'fulfilled' && publicResult.status === 'fulfilled',
    assets,
    activity: priv?.history.map((entry: { kind: string; direction: string; asset: string; amount: bigint }) => ({ kind: entry.kind, direction: entry.direction, symbol: metadata(entry.asset).symbol, amount: formatted(entry.asset, entry.amount) })) ?? [],
  };
}
