/** Exact native WSOL fee policy, separate from the legacy retained-fee model. */
import {quoteExactIn,quoteNativeCurveExit,U64_MAX} from './quote.mjs';
import {createMarket,CURVE,POOL,READY,MIN_CURVE_BASE,u64} from './lifecycle.mjs';
export const FEE_TIERS=Object.freeze([200n,300n,400n]);
export function feeTier(bps){if(!FEE_TIERS.includes(bps))throw new RangeError('Select 2%, 3% or 4%');return bps;}
export function createNativeMarket(args){return Object.freeze({...createMarket({...args,feeBps:0n}),feeBps:feeTier(args.feeBps)});}
export function splitNativeFee(phase,fee){u64(fee);if(phase!==CURVE&&phase!==POOL)throw new RangeError('Invalid phase');const creator=phase===CURVE?fee/5n:0n;return Object.freeze({platform:fee-creator,creator});}
const ceilDiv=(a,b)=>(a+b-1n)/b;
export function grossForNet(net,bps){u64(net,true);return u64(ceilDiv(net*10000n,10000n-feeTier(bps)),true);}
export function nativeSwap(s,buy,amountIn,minimumOut=1n){
  if(typeof buy!=='boolean'||![CURVE,POOL].includes(s.phase))throw new RangeError('wrong phase');
  u64(amountIn,true);u64(minimumOut,true);feeTier(s.feeBps);
  const v=s.phase===CURVE?s.virtualQuote:0n;
  let q,fee,out,next;
  if(buy){q=quoteExactIn({reserveIn:s.quote,reserveOut:s.base,virtualIn:v,virtualOut:0n,amountIn,feeBps:s.feeBps,minimumOut});fee=q.fee;out=q.amountOut;next={...s,quote:u64(s.quote+q.net),base:q.nextReserveOut};}
  else{q=(s.phase===CURVE?quoteNativeCurveExit:quoteExactIn)({reserveIn:s.base,reserveOut:s.quote,virtualIn:0n,virtualOut:v,amountIn,feeBps:0n,minimumOut:1n});fee=ceilDiv(q.amountOut*s.feeBps,10000n);out=q.amountOut-fee;if(out<minimumOut)throw new RangeError('minimum output');next={...s,base:q.nextReserveIn,quote:q.nextReserveOut};}
  if(next.phase===CURVE){if(next.base<MIN_CURVE_BASE)throw new RangeError('curve reserve floor');if(next.quote>=next.graduationQuote)next.phase=READY;}
  next.version=u64(s.version+1n);return Object.freeze({next:Object.freeze(next),amountOut:out,fee,...splitNativeFee(s.phase,fee)});
}
export function accrueFees(owed,q){return Object.freeze({platform:u64(owed.platform+q.platform),creator:u64(owed.creator+q.creator)});}
/** Account schema 2: fixed fields before variable-length metadata. */
export function readFeeLedger(bytes){const b=Buffer.from(bytes);if(b.length!==611||b[8]!==2)throw new Error('Unexpected market fee schema');return Object.freeze({platform:b.readBigUInt64LE(341),creator:b.readBigUInt64LE(349)});}
