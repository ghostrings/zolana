/** Exact release and authority checks. This file contains public data only.
 * An independent review of this application AND the V33 executable is outstanding.
 * Independent approval remains absent. A separate owner market-release decision enables only
 * public market operations against the pinned deployment; it never attests to independent review.
 */
import { V33_REVIEW_RECORD } from './v33-review-record.js';
import { V33_OWNER_MARKET_RECORD } from './v33-owner-market-record.js';
import { V41_RELEASE_RECORD } from './v41-release-record.js';
import { V41_OWNER_RELEASE_RECORD } from './v41-owner-release-record.js';
import { V41_PROFILE, profileFor } from './v41-policy.js';
import { DEPLOYMENT, LOADER, base58, publicKey, hex, digest, decodeProtocol, type RpcRead } from './observe.js';
export const V33 = Object.freeze({
  programId: DEPLOYMENT.programId, programData: DEPLOYMENT.programData, protocol: DEPLOYMENT.protocol,
  genesis: DEPLOYMENT.genesis, upgradeAuthority: DEPLOYMENT.upgradeAuthority,
  admin: DEPLOYMENT.upgradeAuthority,
  treasury: '78XzeLvhyvsgQTirz9LmerGB6PNMDgFhdtHXSWoo83oi',
  pauser: '4xbhc9hzcGZpWpyHsguQbB5JdBZzGTcnBouyk1fbTbwF',
  binaryBytes: 547816, binarySha256: 'bb7545ae08ab37a83f6785f21a019103953c0d43a3e8a47d0162969193e5e411',
  verifyHash: '33a41e48d76fe0bbf936aa41e926a6ebb9005034cfcbf3651318a1ff0e8e9ec5',
  quoteMint: 'So11111111111111111111111111111111111111112',
  supply: '1000000000000', virtualQuote: '100000000', graduationQuote: '200000000', quoteCap: '1000000000',
});
/** Exact public candidate from the uploaded V41 release. Recognition is not approval. */
export const V41_CANDIDATE=Object.freeze({programId:V33.programId,binarySha256:'0bbb6ee73824e8077a0355021c6bf4178f9de0ffbeced0723a0316880e219efd',binaryBytes:550056,verifyHash:'ee9f32d573967169cac33c3510922313e2a8ea418db497d2cfa8dc60d2e5a1df',previousDeploymentSlot:'474345522'});
// Exact one-time allocation transition for the reviewed V41 cutover; original V33 publication is unchanged.
export const V41_EXTENSION_BYTES=10240;
export const V41_EXTENSION_CAPACITY=V33.binaryBytes+V41_EXTENSION_BYTES;
export interface V41OwnerRelease {kind:'owner-authorized-unaudited-v41';enabled:true;programId:string;binarySha256:string;binaryBytes:number;previousDeploymentSlot:string;independentReview:false;privateSettlement:false}
export function parseV41OwnerRelease(value:unknown):V41OwnerRelease|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const r=value as Partial<V41OwnerRelease>,c=V41_CANDIDATE;
  if(r.kind!=='owner-authorized-unaudited-v41'||r.enabled!==true||r.programId!==c.programId||r.binarySha256!==c.binarySha256||r.binaryBytes!==c.binaryBytes||r.previousDeploymentSlot!==c.previousDeploymentSlot||r.independentReview!==false||r.privateSettlement!==false)return null;
  return {kind:r.kind,enabled:true,programId:c.programId,binarySha256:c.binarySha256,binaryBytes:c.binaryBytes,previousDeploymentSlot:c.previousDeploymentSlot,independentReview:false,privateSettlement:false};
}
export function v41OwnerRelease(){return parseV41OwnerRelease(V41_OWNER_RELEASE_RECORD);}
/** Future exact independently reviewed release; historical V33 authorization is never reused. */
export interface V41ReleaseRecord {programId:string;binarySha256:string;binaryBytes:number;deploymentSlot:string;reviewReference:string;applicationReviewed:true;custodyReviewed:true;existingMarketsReviewed:true;privateSettlement:false}
export function parseV41ReleaseRecord(value:unknown):V41ReleaseRecord|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const r=value as Partial<V41ReleaseRecord>;
  if(r.programId!==V33.programId||typeof r.binarySha256!=='string'||!(/^[0-9a-f]{64}$/).test(r.binarySha256)||r.binarySha256!==V41_CANDIDATE.binarySha256||r.binaryBytes!==V41_CANDIDATE.binaryBytes||typeof r.deploymentSlot!=='string'||!(/^[0-9]{1,20}$/).test(r.deploymentSlot)||BigInt(r.deploymentSlot)<=474345522n||typeof r.reviewReference!=='string'||!r.reviewReference.trim()||r.reviewReference.length>1024||r.applicationReviewed!==true||r.custodyReviewed!==true||r.existingMarketsReviewed!==true||r.privateSettlement!==false)return null;
  return {programId:r.programId,binarySha256:r.binarySha256,binaryBytes:r.binaryBytes,deploymentSlot:r.deploymentSlot,reviewReference:r.reviewReference,applicationReviewed:true,custodyReviewed:true,existingMarketsReviewed:true,privateSettlement:false};
}
export function v41ReleaseRecord(){return parseV41ReleaseRecord(V41_RELEASE_RECORD);}
type NativeIdentity=Pick<NativeObservation,'release'|'deploymentSlot'|'binarySha256'|'programCapacityBytes'>;
/** Only the planned zero-padded V33 transition, not an arbitrary same-hash later slot.
 * The marker is derived from the raw finalized account length by inspectNativeRelease.
 */
export function isV33Extended(o:NativeIdentity):boolean {
  return o.release==='v33'&&o.binarySha256===V33.binarySha256&&o.programCapacityBytes===V41_EXTENSION_CAPACITY&&typeof o.deploymentSlot==='string'&&/^[0-9]{1,20}$/.test(o.deploymentSlot)&&BigInt(o.deploymentSlot)>BigInt(V41_CANDIDATE.previousDeploymentSlot);
}
export function isKnownNativeRelease(o:NativeIdentity):boolean {
  if(o.release==='v33')return o.binarySha256===V33.binarySha256&&(o.deploymentSlot===V41_CANDIDATE.previousDeploymentSlot||isV33Extended(o));
  return o.release==='v41'&&o.binarySha256===V41_CANDIDATE.binarySha256&&typeof o.deploymentSlot==='string'&&/^[0-9]{1,20}$/.test(o.deploymentSlot)&&BigInt(o.deploymentSlot)>BigInt(V41_CANDIDATE.previousDeploymentSlot);
}
export interface ReviewedRelease { binarySha256:string; deploymentSlot:string; reviewReference:string; applicationReviewed:true; custodyReviewed:true }
// This is a source-controlled review record, not an input, environment variable, or RPC result.
// A future reviewed release must supply its real independently approved record. Never self-attest.
export function parseReviewedRelease(value:unknown): ReviewedRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r=value as Partial<ReviewedRelease>;
  if(r.binarySha256!==V33.binarySha256||r.deploymentSlot!=='474345522'||r.applicationReviewed!==true||r.custodyReviewed!==true||typeof r.reviewReference!=='string'||!r.reviewReference.trim()||r.reviewReference.length>1024)return null;
  return {binarySha256:r.binarySha256,deploymentSlot:r.deploymentSlot,reviewReference:r.reviewReference,applicationReviewed:true,custodyReviewed:true};
}
export function reviewedRelease(): ReviewedRelease | null { return parseReviewedRelease(V33_REVIEW_RECORD); }
export type NativeConfig = { mode:'locked'|'active'|'paused'; admin:string; treasury:string; pauser:string; pendingAdmin:string };
export type NativeObservation = { release:'v27-locked'|'v33'|'v41'; source:'finalized-rpc'; slot:number; deploymentSlot:string; binarySha256:string; config:NativeConfig|null; protocolInitialized:boolean; privateSettlement:false; programCapacityBytes?:number };
export function need(ok:unknown,message:string): asserts ok { if (!ok) throw new Error(message); }
function obj(value:unknown):Record<string,unknown> { need(value && typeof value==='object'&&!Array.isArray(value),'Invalid RPC object'); return value as Record<string,unknown>; }
function slot(value:unknown):number { need(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0,'Invalid slot');return value; }
function frame(raw:unknown){const o=obj(raw);return {slot:slot(obj(o.context).slot),value:o.value};}
function data(raw:unknown,owner:string,executable:boolean,max:number):Uint8Array {
  const o=obj(raw);need(o.owner===owner&&o.executable===executable,'Unexpected owner or executable');
  need(Array.isArray(o.data)&&o.data.length===2&&o.data[1]==='base64'&&typeof o.data[0]==='string','Invalid account encoding');
  const b64=o.data[0] as string;need(b64.length<=Math.ceil(max/3)*4&&/^[A-Za-z0-9+/]*={0,2}$/.test(b64),'Account too large or malformed');
  const b=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));need(b.length<=max,'Account exceeds bound');return b;
}
const view=(b:Uint8Array)=>new DataView(b.buffer,b.byteOffset,b.byteLength);
function addr(b:Uint8Array,off:number){need(off+32<=b.length,'Truncated address');return base58(b.subarray(off,off+32));}
const ZERO='11111111111111111111111111111111';
export function decodeV33Config(raw:unknown):NativeConfig|null {
  if(raw===null)return null;
  const b=data(raw,V33.programId,false,139);
  need(b.length===139&&hex(b.subarray(0,8))==='cf5bfa1c98b3d7d1'&&b[8]===2,'Unexpected V33 config schema');
  const mode=(['locked','active','paused'] as const)[b[10]!];need(mode,'Unknown config mode');
  const admin=addr(b,11),pauser=addr(b,43),pendingAdmin=addr(b,75),treasury=addr(b,107);
  need(admin===V33.admin&&pauser===V33.pauser&&treasury===V33.treasury&&pendingAdmin===ZERO,'Authority configuration changed or nomination pending');
  return {mode,admin,pauser,treasury,pendingAdmin};
}
/** One finalized snapshot pins loader, ProgramData, executable, slot and roles.
 * Supports exactly historical V27 and the reviewed-file V33 candidate; no unknown upgrade is accepted.
 */
export async function inspectNativeRelease(rpc:RpcRead):Promise<NativeObservation> {
  need(await rpc('getGenesisHash')===V33.genesis,'Wrong network');
  const f=frame(await rpc('getMultipleAccounts',[[V33.programId,V33.programData,V33.protocol],{encoding:'base64',commitment:'finalized'}]));
  need(Array.isArray(f.value)&&f.value.length===3,'Invalid release snapshot');
  const [p,pd,c]=f.value;
  const prog=data(p,LOADER,true,36);need(prog.length===36&&view(prog).getUint32(0,true)===2&&addr(prog,4)===V33.programData,'Wrong ProgramData pointer');
  // Loader can allocate additional zeroed bytes. Never accept nonzero trailing executable data.
  const bytes=data(pd,LOADER,false,2*1024*1024);
  need(bytes.length>=45+DEPLOYMENT.binaryBytes&&view(bytes).getUint32(0,true)===3&&bytes[12]===1&&addr(bytes,13)===V33.upgradeAuthority,'Unexpected ProgramData or authority');
  const deployed=view(bytes).getBigUint64(4,true);need(deployed<=BigInt(f.slot)&&deployed>=BigInt(DEPLOYMENT.deploymentSlot),'Invalid deployment slot');
  async function matches(n:number,hash:string){return bytes.length>=45+n&&bytes.subarray(45+n).every(x=>x===0)&&await digest(bytes.subarray(45,45+n))===hash;}
  if(deployed===BigInt(DEPLOYMENT.deploymentSlot)&&await matches(DEPLOYMENT.binaryBytes,DEPLOYMENT.binarySha256)) {
    const cfg=decodeProtocol(c);need(cfg===null||cfg.mode==='locked','Unexpected V27 protocol state');
    // The older configuration is intentionally not interpreted as schema 2.
    return {release:'v27-locked',source:'finalized-rpc',slot:f.slot,deploymentSlot:String(deployed),binarySha256:DEPLOYMENT.binarySha256,config:null,protocolInitialized:cfg!==null,privateSettlement:false};
  }
  const next=V41_CANDIDATE;
  if(deployed>BigInt(next.previousDeploymentSlot)&&await matches(next.binaryBytes,next.binarySha256)){
    const config=decodeV33Config(c);
    return {release:'v41',source:'finalized-rpc',slot:f.slot,deploymentSlot:String(deployed),binarySha256:next.binarySha256,config,protocolInitialized:config!==null,privateSettlement:false};
  }
  need(deployed>BigInt(DEPLOYMENT.deploymentSlot)&&await matches(V33.binaryBytes,V33.binarySha256),'Unknown executable or slot; stop for review');
  const config=decodeV33Config(c);
  return {release:'v33',source:'finalized-rpc',slot:f.slot,deploymentSlot:String(deployed),binarySha256:V33.binarySha256,config,protocolInitialized:config!==null,privateSettlement:false,...(bytes.length===45+V41_EXTENSION_CAPACITY&&deployed>BigInt(next.previousDeploymentSlot)?{programCapacityBytes:V41_EXTENSION_CAPACITY}:{})};
}
export type NativeAction='initialize'|'launch'|'buy'|'sell'|'graduate'|'claim';
export interface OwnerMarketRelease {
  kind:'owner-authorized-unaudited-market-release'; enabled:true; programId:string;
  binarySha256:string; deploymentSlot:string; independentReview:false; privateSettlement:false;
}
export function parseOwnerMarketRelease(value:unknown):OwnerMarketRelease|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const r=value as Partial<OwnerMarketRelease>;
  if(r.kind!=='owner-authorized-unaudited-market-release'||r.enabled!==true||r.programId!==V33.programId||r.binarySha256!==V33.binarySha256||r.deploymentSlot!=='474345522'||r.independentReview!==false||r.privateSettlement!==false)return null;
  return {kind:r.kind,enabled:true,programId:r.programId,binarySha256:r.binarySha256,deploymentSlot:r.deploymentSlot,independentReview:false,privateSettlement:false};
}
export function ownerMarketRelease():OwnerMarketRelease|null {return parseOwnerMarketRelease(V33_OWNER_MARKET_RECORD);}
/** The owner decision covers only buys, sells, graduation and beneficiary fee claims.
 * Launch and initialize still follow their existing approval paths. The program itself checks
 * signatures, reserve caps, deadlines, phase, slippage, fee beneficiaries, and pause controls.
 * Never turn the owner decision into a ReviewedRelease.
 */
export function signingAllowed(o:NativeObservation,action:NativeAction,approval:ReviewedRelease|null=reviewedRelease(),ownerApproval:OwnerMarketRelease|null=ownerMarketRelease(),v41OwnerApproval:V41OwnerRelease|null=v41OwnerRelease()):boolean {
  if(o.release==='v41'){
    const c=o.config,review=v41ReleaseRecord();
    const authorized=!!parseV41OwnerRelease(v41OwnerApproval)||(!!review&&review.deploymentSlot===o.deploymentSlot);
    return authorized&&isKnownNativeRelease(o)&&o.source==='finalized-rpc'&&o.privateSettlement===false&&o.protocolInitialized===true&&Number.isSafeInteger(o.slot)&&o.slot>=0&&BigInt(o.deploymentSlot)<=BigInt(o.slot)&&!!c&&c.admin===V33.admin&&c.treasury===V33.treasury&&c.pauser===V33.pauser&&c.pendingAdmin===ZERO&&['launch','buy','sell','graduate','claim'].includes(action)&&(c.mode==='active'||(c.mode==='paused'&&['sell','graduate','claim'].includes(action)));
  }
  if(!['initialize','launch','buy','sell','graduate','claim'].includes(action)||o.release!=='v33'||o.source!=='finalized-rpc'||o.binarySha256!==V33.binarySha256||o.privateSettlement!==false||!Number.isSafeInteger(o.slot)||o.slot<0||!/^\d+$/.test(o.deploymentSlot)||BigInt(o.deploymentSlot)>BigInt(o.slot))return false;
  const independentlyApproved=!!approval&&approval.applicationReviewed===true&&approval.custodyReviewed===true&&typeof approval.reviewReference==='string'&&!!approval.reviewReference.trim()&&approval.binarySha256===V33.binarySha256&&approval.deploymentSlot===o.deploymentSlot;
  const owner=parseOwnerMarketRelease(ownerApproval);
  const extensionApproved=isV33Extended(o)&&!!parseV41OwnerRelease(v41OwnerApproval);
  const ownerApproved=!!owner&&(owner.deploymentSlot===o.deploymentSlot||extensionApproved)&&['buy','sell','graduate','claim'].includes(action);
  if(!independentlyApproved&&!ownerApproved)return false;
  if(action==='initialize')return independentlyApproved&&!o.protocolInitialized&&o.config===null;
  const c=o.config;if(!o.protocolInitialized||!c||c.admin!==V33.admin||c.treasury!==V33.treasury||c.pauser!==V33.pauser||c.pendingAdmin!==ZERO)return false;
  return c.mode==='active'||(c.mode==='paused'&&['sell','graduate','claim'].includes(action));
}
export interface MarketV33 {address:string;creator:string;nonce:string;baseMint:string;quoteMint:string;lpMint:string;baseVault:string;quoteVault:string;lpLock:string;phase:'curve'|'ready'|'pool';version:string;baseReserve:string;quoteReserve:string;virtualQuote:string;graduationQuote:string;feeBps:number;initialSupply:string;burned:string;lockedLp:string;treasury:string;platformFees:string;creatorFees:string;name:string;symbol:string;metadataUri:string}
export function decodeV33Market(address:string,raw:unknown):MarketV33 {
  publicKey(address);const b=data(raw,V33.programId,false,611),v=view(b);
  need(b.length===611&&hex(b.subarray(0,8))==='dbbed53700e3c69a'&&b[8]===2,'Unexpected market schema');
  const phase=(['curve','ready','pool'] as const)[b[10]!];need(phase,'Invalid phase');
  const u=(off:number)=>String(v.getBigUint64(off,true));
  const feeBps=v.getUint16(283,true),baseReserve=u(251),quoteReserve=u(259),platformFees=u(341),creatorFees=u(349),treasury=addr(b,309);
  const profile=profileFor(u(285),u(267),u(275));
  need(profile&&[200,300,400].includes(feeBps)&&addr(b,83)===V33.quoteMint&&treasury===V33.treasury,'Market profile mismatch');
  need(BigInt(baseReserve)>0n&&BigInt(baseReserve)<=BigInt(profile.supply)&&BigInt(quoteReserve)+BigInt(platformFees)+BigInt(creatorFees)<=BigInt(profile.quoteCap),'Market reserve mismatch');
  let off=357; const text=(max:number)=>{need(off+4<=b.length,'Truncated metadata');const n=v.getUint32(off,true);off+=4;need(n<=max&&off+n<=b.length,'Invalid metadata');const s=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(off,off+n));off+=n;return s;};
  const name=text(32),symbol=text(10),metadataUri=text(200);need(name.length>0&&!/\p{Cc}/u.test(name)&&/^[A-Z0-9]{1,10}$/.test(symbol)&&!/\p{Cc}/u.test(metadataUri),'Invalid metadata fields');
  return {address,creator:addr(b,11),nonce:u(43),baseMint:addr(b,51),quoteMint:addr(b,83),lpMint:addr(b,115),baseVault:addr(b,147),quoteVault:addr(b,179),lpLock:addr(b,211),phase,version:u(243),baseReserve,quoteReserve,virtualQuote:u(267),graduationQuote:u(275),feeBps,initialSupply:u(285),burned:u(293),lockedLp:u(301),treasury,platformFees,creatorFees,name,symbol,metadataUri};
}
/** Bounded discovery, not fabricated index data. No query-supplied program or filter. */
export async function scanV33(rpc:RpcRead):Promise<{slot:number;markets:MarketV33[]}> {
  const before=await inspectNativeRelease(rpc);need((before.release==='v33'||before.release==='v41')&&before.config,'Native market program is not initialized');
  const r=frame(await rpc('getProgramAccounts',[V33.programId,{encoding:'base64',commitment:'finalized',withContext:true,minContextSlot:before.slot,filters:[{dataSize:611},{memcmp:{offset:0,bytes:base58(Uint8Array.from([219,190,213,55,0,227,198,154]))}}]}]));
  need(r.slot>=before.slot&&Array.isArray(r.value)&&r.value.length<=500,'Invalid or over-limit market snapshot');
  const seen=new Set<string>(),markets=r.value.map(x=>{const a=obj(x);need(typeof a.pubkey==='string'&&!seen.has(a.pubkey),'Invalid or duplicate address');seen.add(a.pubkey);return decodeV33Market(a.pubkey,a.account);});
  const after=await inspectNativeRelease(rpc);need(after.release===before.release&&after.binarySha256===before.binarySha256&&after.deploymentSlot===before.deploymentSlot&&after.slot>=r.slot,'Deployment changed or RPC is stale');
  need(before.release==='v41'||markets.every(m=>m.virtualQuote!==V41_PROFILE.virtualQuote),'Future profile not valid for V33');
  return {slot:r.slot,markets:markets.sort((a,b)=>a.address.localeCompare(b.address))};
}
export interface LaunchIntent {network:'mainnet-beta'; programId:string; candidateHash:string; creator:string; name:string; symbol:string; feeBps:200|300|400; supply:string; quoteMint:string; treasury:string; approver:string; privateSettlement:false; kind:'unsigned-launch-intent'}
export function launchIntent(creator:string,name:string,symbol:string,feeBps:number):LaunchIntent {
  publicKey(creator);need(creator!==ZERO&&creator!==V33.admin&&creator!==V33.treasury,'Choose a distinct creator wallet');
  need(typeof name==='string'&&name.length>0&&new TextEncoder().encode(name).length<=32&&!/\p{Cc}/u.test(name),'Name must be 1–32 UTF-8 bytes');
  need(/^[A-Z0-9]{1,10}$/.test(symbol),'Symbol must be 1–10 uppercase letters or digits');need(feeBps===200||feeBps===300||feeBps===400,'Select 2%, 3% or 4%');
  return {network:'mainnet-beta',programId:V33.programId,candidateHash:V33.binarySha256,creator,name,symbol,feeBps,supply:V33.supply,quoteMint:V33.quoteMint,treasury:V33.treasury,approver:V33.admin,privateSettlement:false,kind:'unsigned-launch-intent'};
}
/** Public operator review only: no blockhash, payer signature, or transaction serialization. */
export function initializationPlan(){
  const keys=[
    {name:'authority',address:V33.upgradeAuthority,signer:true,writable:true},
    {name:'program',address:V33.programId,signer:false,writable:false},
    {name:'program_data',address:V33.programData,signer:false,writable:false},
    {name:'protocol',address:V33.protocol,signer:false,writable:true},
    {name:'system_program',address:ZERO,signer:false,writable:false},
    {name:'treasury',address:V33.treasury,signer:true,writable:false},
  ];
  return {kind:'unsigned-instruction-review',network:'mainnet-beta',programId:V33.programId,binarySha256:V33.binarySha256,instruction:'initialize_protocol',accounts:keys,dataHex:hex(Uint8Array.from([188,233,252,106,134,146,202,91,...publicKey(V33.pauser)])),initialMode:'locked',privateSettlement:false,activationIncluded:false};
}
