import { LAB_ASSETS, LAB_MEMBERS, type LabAsset, type LabSnapshot } from './lab.js';

/** Local synthetic aggregates, intentionally NOT accepted as an on-chain report. */
export const LAB_MIN_HOLDERS = 12;
export interface LabAggregate {
  readonly source: 'synthetic-local';
  readonly asset: LabAsset;
  readonly sequence: number;
  readonly holderCount: number | null;
  readonly ringUnits: string;
  readonly totalSupplyUnits: string;
  readonly ringShareBps: number;
  readonly topTenShareBps: number | null;
  readonly declaredCreatorShareBps: null;
}
function bps(part: bigint, total: bigint): number { return total === 0n ? 0 : Number(part * 10_000n / total); }
export function labAggregate(snapshot: LabSnapshot): LabAggregate {
  if (snapshot.source !== 'synthetic-local' || !LAB_ASSETS.includes(snapshot.asset)
    || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0
    || typeof snapshot.totalSupply !== 'bigint' || snapshot.totalSupply <= 0n
    || !Array.isArray(snapshot.balances) || snapshot.balances.length !== LAB_MEMBERS.length
    || Array.from(snapshot.balances).some((balance) => typeof balance !== 'bigint' || balance < 0n)) throw new Error('Invalid synthetic snapshot.');
  const ring = snapshot.balances.reduce((sum, balance) => sum + balance, 0n);
  if (ring > snapshot.totalSupply) throw new Error('Ring balance exceeds synthetic supply.');
  const positive = snapshot.balances.filter((balance) => balance > 0n);
  const count = positive.length;
  const top = [...positive].sort((a, b) => a === b ? 0 : a > b ? -1 : 1).slice(0, 10).reduce((sum, balance) => sum + balance, 0n);
  return {
    source: 'synthetic-local', asset: snapshot.asset, sequence: snapshot.sequence,
    holderCount: count >= LAB_MIN_HOLDERS ? count : null,
    ringUnits: ring.toString(), totalSupplyUnits: snapshot.totalSupply.toString(), ringShareBps: bps(ring, snapshot.totalSupply),
    topTenShareBps: count >= LAB_MIN_HOLDERS ? bps(top, ring) : null,
    declaredCreatorShareBps: null,
  };
}
