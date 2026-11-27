/** Native token page display and shortcuts only. No RPC, wallet, key or transaction methods. */
import {formatUnits} from './launch-policy.mjs';
const U64_MAX=(1n<<64n)-1n;
export const SELL_SHARES=Object.freeze([25,50,75,100]);
export function matchingPublicBalance(balance,owner,mint){
 if(!balance||!owner||!mint||balance.owner!==owner||balance.mint!==mint||!Number.isSafeInteger(balance.slot)||balance.slot<0)return null;
 return ['sol','tokens','wsol'].every(k=>typeof balance[k]==='bigint'&&balance[k]>=0n&&balance[k]<=U64_MAX)?balance:null;
}
export function sellShareAmount(balance,percent){
 if(typeof balance!=='bigint'||balance<0n||balance>U64_MAX||!SELL_SHARES.includes(percent))throw Error('Invalid public token balance or share');
 const units=balance*BigInt(percent)/100n;
 return units===0n?null:formatUnits(units,6);
}
export function sellInputUnits(value){
 if(typeof value!=='string'||!/^\d{1,20}(?:\.\d{1,6})?$/.test(value))return null;
 const [whole,fraction='']=value.split('.');const units=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
 return units>0n&&units<=U64_MAX?units:null;
}
/** Display-only estimate, calculated from the current reserve ratio and verified mint supply. */
export function nativeCapLamports(m,supply){
 if(typeof supply!=='bigint'||supply<0n||supply>BigInt(m.initialSupply)||!['curve','ready','pool'].includes(m.phase))throw Error('Invalid mint supply or phase');
 const base=BigInt(m.baseReserve),quote=BigInt(m.quoteReserve),virtual=BigInt(m.virtualQuote);
 if(base<=0n||quote<0n||virtual<0n)throw Error('Invalid market reserves');
 return supply*(quote+(m.phase==='pool'?0n:virtual))/base;
}
/** Real timestamp geometry, with no invented observations or extrapolation. */
export function nativeChartGeometry(points){
 const rows=points.filter(p=>Number.isSafeInteger(p.time)&&p.time>0&&Number.isFinite(p.price)&&p.price>0).slice().sort((a,b)=>a.time-b.time);
 if(rows.length<2||rows.at(-1).time<=rows[0].time)return null;
 const lo=Math.min(...rows.map(p=>p.price)),hi=Math.max(...rows.map(p=>p.price)),first=rows[0].time,last=rows.at(-1).time;
 const coords=rows.map(p=>({x:32+656*(p.time-first)/(last-first),y:hi===lo?145:246-202*(p.price-lo)/(hi-lo)}));
 return {coords,first,last,lastPrice:rows.at(-1).price};
}

/** Compact display only. Never feed formatted/rounded figures to transaction builders. */
export function nativeDecimal(value,significant=4){
 const n=Number(value);if(!Number.isFinite(n)||n<0)return String(value);if(n===0)return '0';
 const places=Math.max(0,Math.min(18,significant-1-Math.floor(Math.log10(n))));
 const raw=n.toFixed(places);return places===0?raw:raw.replace(/0+$/,'').replace(/\.$/,'');
}
