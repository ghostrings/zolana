/** Independent BigInt reference for the PUBLIC SPL market lifecycle. */
import { quoteExactIn, U64_MAX } from './quote.mjs';
export const CURVE = 0, READY = 1, POOL = 2;
export const MIN_CURVE_BASE = 1_000n, MIN_VIRTUAL_QUOTE = 1_000n, MAX_FEE_BPS = 100n;
function check(ok, reason) { if (!ok) throw new RangeError(reason); }
export function u64(v, positive = false) { check(typeof v === 'bigint' && v >= (positive ? 1n : 0n) && v <= U64_MAX, 'invalid u64 or overflow'); return v; }
const ceilDiv = (a,b) => a/b + (a%b === 0n ? 0n : 1n);
function bump(s) { return Object.freeze({...s,version:u64(s.version+1n)}); }
export function sqrt(n) {
  check(typeof n === 'bigint' && n >= 0n && n <= U64_MAX*U64_MAX + 2n*U64_MAX, 'invalid u128');
  let lo=0n,hi=U64_MAX;
  while (lo<hi) { const m=lo+(hi-lo)/2n+1n; if(m*m<=n) lo=m; else hi=m-1n; }
  return lo;
}
export function createMarket({supply,virtualQuote,graduationQuote,feeBps}) {
  for (const n of [supply,virtualQuote,graduationQuote,feeBps]) u64(n);
  check(supply>=2n*MIN_CURVE_BASE && virtualQuote>=MIN_VIRTUAL_QUOTE && graduationQuote>=virtualQuote && feeBps<=MAX_FEE_BPS,'invalid config');
  u64(graduationQuote+virtualQuote);
  check(supply*virtualQuote>=MIN_CURVE_BASE*(graduationQuote+virtualQuote),'unreachable curve floor');
  return Object.freeze({phase:CURVE,version:0n,base:supply,quote:0n,virtualQuote,graduationQuote,feeBps});
}
export function guard(s,expectedVersion,deadlineSlot,currentSlot) {
  for(const n of [expectedVersion,deadlineSlot,currentSlot]) u64(n);
  check(expectedVersion===s.version,'stale version'); check(deadlineSlot>=currentSlot,'expired slot');
}
export function swap(s,buy,amountIn,minimumOut=1n) {
  check(typeof buy==='boolean' && (s.phase===CURVE||s.phase===POOL),'wrong phase');
  const v=s.phase===CURVE?s.virtualQuote:0n;
  const q=quoteExactIn({reserveIn:buy?s.quote:s.base,reserveOut:buy?s.base:s.quote,virtualIn:buy?v:0n,virtualOut:buy?0n:v,amountIn,feeBps:s.feeBps,minimumOut});
  const next={...s,base:buy?q.nextReserveOut:q.nextReserveIn,quote:buy?q.nextReserveIn:q.nextReserveOut};
  if(next.phase===CURVE){check(next.base>=MIN_CURVE_BASE,'curve reserve floor'); if(next.quote>=next.graduationQuote) next.phase=READY;}
  return Object.freeze({next:bump(next),amountOut:q.amountOut,fee:q.fee});
}
export function graduate(s) {
  check(s.phase===READY,'wrong phase');
  check(s.base>=MIN_CURVE_BASE && s.quote>=s.graduationQuote && s.quote>=s.virtualQuote,'invalid graduation state');
  const poolBase=s.base*s.quote/u64(s.quote+s.virtualQuote,true);
  check(poolBase>0n && poolBase<=s.base,'curve reserve floor');
  const lockedLp=sqrt(poolBase*s.quote);check(lockedLp>0n,'invalid liquidity');
  return Object.freeze({next:bump({...s,phase:POOL,base:poolBase}),baseToBurn:s.base-poolBase,lockedLp});
}
export function addLiquidity(s,supply,maxBase,maxQuote,minShares=1n) {
  check(s.phase===POOL,'wrong phase');
  for(const n of [supply,maxBase,maxQuote,minShares,s.base,s.quote]) u64(n,true);
  const a=maxBase*supply/s.base,b=maxQuote*supply/s.quote;
  const shares=u64(a<b?a:b,true);check(shares>=minShares,'minimum shares');u64(supply+shares);
  const baseAmount=u64(ceilDiv(shares*s.base,supply),true),quoteAmount=u64(ceilDiv(shares*s.quote,supply),true);
  check(baseAmount<=maxBase && quoteAmount<=maxQuote,'maximum inputs');
  return Object.freeze({next:bump({...s,base:u64(s.base+baseAmount),quote:u64(s.quote+quoteAmount)}),baseAmount,quoteAmount,shares});
}
export function removeLiquidity(s,supply,locked,shares,minBase=1n,minQuote=1n) {
  check(s.phase===POOL,'wrong phase');
  for(const n of [supply,locked,shares,minBase,minQuote]) u64(n,true);
  check(supply>=locked && shares<=supply-locked,'locked or invalid shares');
  const baseAmount=u64(shares*s.base/supply),quoteAmount=u64(shares*s.quote/supply);
  check(baseAmount>=minBase && quoteAmount>=minQuote,'minimum outputs');
  const base=u64(s.base-baseAmount,true),quote=u64(s.quote-quoteAmount,true);
  return Object.freeze({next:bump({...s,base,quote}),baseAmount,quoteAmount,shares});
}
