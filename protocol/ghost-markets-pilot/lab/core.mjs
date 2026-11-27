/** Exact base-unit input and quotes for the local-only public market lab. */
import { graduate, CURVE, READY, POOL } from '../reference/lifecycle.mjs';
import { PROFILE, assertMetadata, assertQuoteCap } from '../reference/pilot-profile.mjs';
import { U64_MAX } from '../reference/quote.mjs';
import {feeTier,nativeSwap,accrueFees,readFeeLedger} from '../reference/native-fees.mjs';
const positive = (x, name) => { if (typeof x !== 'bigint' || x <= 0n || x > U64_MAX) throw new Error(`Invalid ${name}`); return x; };
export function parseUnits(value, decimals) {
  if (typeof value !== 'string' || value.length > 40 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new Error('Use a positive decimal amount, not scientific notation');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return positive(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals,'0') || '0'), 'amount');
}
export function units(value, decimals) {
  const s = BigInt(value).toString().padStart(decimals + 1, '0');
  return `${s.slice(0,-decimals)}.${s.slice(-decimals)}`;
}
export function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64_MAX) throw new Error('Invalid quote version');
  return BigInt(value);
}
export function assertLaunch(body) { assertMetadata(body.name,body.symbol); if(!['200','300','400'].includes(body.feeBps))throw new Error('Choose 2%, 3% or 4%'); return {name:body.name,symbol:body.symbol,feeBps:feeTier(BigInt(body.feeBps))}; }
export function marketState(data) {
  const b = Buffer.from(data);
  if (b.length !== 611 || b.subarray(0,8).toString('hex') !== 'dbbed53700e3c69a' || b[8] !== 2 || ![CURVE,READY,POOL].includes(b[10])) throw new Error('Invalid market schema');
  const s={phase:b[10],version:b.readBigUInt64LE(243),base:b.readBigUInt64LE(251),quote:b.readBigUInt64LE(259),virtualQuote:b.readBigUInt64LE(267),graduationQuote:b.readBigUInt64LE(275),feeBps:BigInt(b.readUInt16LE(283))};
  if(s.virtualQuote!==PROFILE.virtualQuote||s.graduationQuote!==PROFILE.graduationQuote||!([200n,300n,400n].includes(s.feeBps))||b.readBigUInt64LE(285)!==PROFILE.supply||s.base===0n||s.base>PROFILE.supply) throw new Error('Unexpected pilot profile');
  const fees=readFeeLedger(b);assertQuoteCap(s,fees.platform+fees.creator); return s;
}
export function protocolMode(data) {
  const b=Buffer.from(data);
  if (b.length!==139 || b.subarray(0,8).toString('hex')!=='cf5bfa1c98b3d7d1'||b[8]!==2||![0,1,2].includes(b[10])) throw new Error('Invalid protocol config');
  return b[10];
}
export function quoteAction(s, lpSupply, lpLocked, mode, body, owed={platform:0n,creator:0n}) {
  if(parseVersion(body.version)!==s.version) throw new Error('Market version changed; refresh quote');
  const action=body.action;
  if(mode!==1 && !(mode===2&&(action==='graduate'||(action==='sell'&&[CURVE,POOL].includes(s.phase))))) throw new Error('Action blocked by protocol mode');
  switch(action){
    case 'buy': case 'sell': {
      const buy=action==='buy',amountIn=parseUnits(body.amount,buy?9:6);
      const q=nativeSwap(s,buy,amountIn); const nextOwed=accrueFees(owed,q); if(buy)assertQuoteCap(q.next,nextOwed.platform+nextOwed.creator);
      return {action,amountIn,minimumOut:q.amountOut,fee:q.fee,platformFee:q.platform,creatorFee:q.creator,nextOwed,next:q.next};
    }
    case 'graduate': {const g=graduate(s);return {action,baseToBurn:g.baseToBurn,lockedLp:g.lockedLp,next:g.next};}
    case 'add': case 'remove': throw new Error('Native pilot: all LP principal is locked');
    default:throw new Error('Unknown operation');
  }
}
// A validation/quote refusal before any transaction submission is recoverable.
// If a send may have begun, do not retry automatically; restart and inspect state.
export function actionFailure(mutationStarted, error) {
  return mutationStarted
    ? {halted:true,error:'Operation did not complete cleanly. Lab halted; inspect state and restart rather than resubmit.'}
    : {halted:false,error:String(error?.message??'Local request failed').slice(0,200)};
}
export function json(value){return JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);}
export const LOOPBACK_ORIGIN='http://127.0.0.1:17828';
export function allowedRequest(req,token){
  return req.headers.host==='127.0.0.1:17828' && (req.method==='GET'||(req.method==='POST'&&req.headers.origin===LOOPBACK_ORIGIN&&req.headers['x-ghost-lab-token']===token&&req.headers['content-type']==='application/json'));
}
