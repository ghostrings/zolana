/** Bounded public V33 event reader. No wallet addresses are queried and no private activity is inferred. */
import {Buffer} from 'buffer';
const DISC={swap:'96a61ae11c59264f',created:'58b882e7e254063a',graduated:'33f142328cf59cc0'};
const PHASE=['curve','ready','pool'];
const sigPattern=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const addrPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const assert=(v,m)=>{if(!v)throw Error(m);};
const slot=v=>Number.isSafeInteger(v)&&v>=0;
export const HISTORY_LIMIT=10; // Existing relay limit; no change to relay permissions.
export function decodeMarketEvent(bytes,marketBytes){
 const b=Buffer.from(bytes),m=Buffer.from(marketBytes);if(m.length!==32||b.length<40||!b.subarray(8,40).equals(m))return null;
 const type=b.subarray(0,8).toString('hex'),u=i=>b.readBigUInt64LE(i).toString();
 if(type===DISC.created){
  if(b.length!==170)return null;
  const fee=b.readUInt16LE(168);if(![200,300,400].includes(fee)||u(136)!=='1000000000000'||u(144)!=='0'||!((u(152)==='100000000'&&u(160)==='200000000')||(u(152)==='3500000000'&&u(160)==='12040270268')))return null;
  return {kind:'launch',version:'0',supply:u(136),feeBps:fee};
 }
 if(type===DISC.swap){
  if(b.length!==122||b[72]>1||!PHASE[b[113]]||b.readBigUInt64LE(73)===0n||b.readBigUInt64LE(81)===0n||b.readBigUInt64LE(97)===0n||b.readBigUInt64LE(114)===0n)return null;
  const buy=b[72]===1;return {kind:buy?'buy':'sell',tokenUnits:u(buy?81:73),quoteLamports:u(buy?73:81),feeLamports:u(89),baseReserve:u(97),quoteReserve:u(105),phase:PHASE[b[113]],version:u(114)};
 }
 if(type===DISC.graduated){
  if(b.length!==80||b.readBigUInt64LE(48)===0n||b.readBigUInt64LE(56)===0n||b.readBigUInt64LE(64)===0n||b.readBigUInt64LE(72)===0n)return null;
  return {kind:'graduation',burned:u(40),lockedLp:u(48),baseReserve:u(56),quoteReserve:u(64),version:u(72)};
 }
 return null;
}
/** Only emit from the target program's active invocation, in a successful finalized transaction.
 * Truncated logs, unexpected stack transitions, and missing metadata are incomplete, not zero trades. */
export function eventsFromLogs(logs,program,marketBytes){
 assert(addrPattern.test(program)&&Array.isArray(logs)&&logs.length<=2000,'Invalid public event log');
 const stack=[],events=[];let complete=true;
 for(const line of logs){
  if(typeof line!=='string'||line.length>20000){complete=false;break;}
  if(/log truncated/i.test(line)){complete=false;break;}
  let p=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/);
  if(p){if(Number(p[2])!==stack.length+1||stack.length>=64){complete=false;break;}stack.push(p[1]);continue;}
  p=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed:.*)$/);
  if(p){if(stack.pop()!==p[1]){complete=false;break;}if(p[2]!=='success'){complete=false;break;}continue;}
  if(stack.at(-1)!==program||!line.startsWith('Program data: '))continue;
  const data=line.slice(14);if(data.length>512||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))continue;
  const b=Buffer.from(data,'base64');if(b.toString('base64')!==data)continue;
  const event=decodeMarketEvent(b,marketBytes);if(event)events.push(event);
 }
 return {events:complete&&stack.length===0?events:[],complete:complete&&stack.length===0};
}
export async function readRecentMarketHistory({connection,market,program,releaseSlot,minContextSlot=releaseSlot}){
 assert(slot(releaseSlot)&&slot(minContextSlot)&&minContextSlot>=releaseSlot&&addrPattern.test(program),'Invalid release');
 const list=await connection.getSignaturesForAddress(market,{limit:HISTORY_LIMIT,minContextSlot},'finalized');
 assert(Array.isArray(list)&&list.length<=HISTORY_LIMIT,'Invalid history response');
 const seen=new Set(),rows=[];let unavailable=0,failed=0,preRelease=0;
 for(const s of list){
  assert(sigPattern.test(s?.signature??'')&&slot(s.slot)&&!seen.has(s.signature),'Invalid signature history');seen.add(s.signature);
  if(s.slot<releaseSlot){preRelease++;continue;}
  if(s.err!==null){failed++;continue;}
  try{
   const tx=await connection.getTransaction(s.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
   if(!tx||tx.slot!==s.slot||tx.meta?.err!==null||!Array.isArray(tx.meta.logMessages)||tx.transaction?.signatures?.[0]!==s.signature){unavailable++;continue;}
   const r=eventsFromLogs(tx.meta.logMessages,program,market.toBytes());if(!r.complete){unavailable++;continue;}
   const time=Number.isSafeInteger(tx.blockTime)&&tx.blockTime>0&&tx.blockTime<=253402300799?tx.blockTime:null;
   r.events.forEach((e,i)=>rows.push({...e,signature:s.signature,slot:s.slot,time,eventIndex:i}));
  }catch{unavailable++;}
 }
 // A bounded recent window, not an exhaustive volume index. Keep missing logs explicit.
 return {rows,checked:list.length,unavailable,failed,preRelease,limit:HISTORY_LIMIT,coverage:'recent-finalized-signatures-only'};
}
