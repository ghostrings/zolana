/** First owner-approved native market. Public SPL issuance only. No buy,
 * transfer, registration, arbitrary instruction, private settlement, or activation.
 * The existing durable nonce remains controlled by the pinned administrator.
 */
import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { V33, launchIntent } from '../../../shared/src/ghost-markets/v33-release.ts';
import { context, create, marketKeys } from './instructions.mjs';
import { mergeWalletWire, sameBytes } from '../../../protocol/ghost-markets-pilot/wallet/wire.mjs';
export const LIVE_SLOT='474345522';
const need=(v,msg)=>{if(!v)throw Error(msg);};
const key=s=>{need(typeof s==='string'&&s.length<=44,'Invalid public address');const k=new PublicKey(s);need(k.toBase58()===s,'Noncanonical address');return k;};
const exact=(o,fields)=>need(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===fields.slice().sort().join(','),'Unexpected approval fields');
export async function launchNonceAddress(){return PublicKey.createWithSeed(key(V33.admin),'ghost-v33-init-v1',SystemProgram.programId);}
export async function launchSpec(values,n){
 const i=launchIntent(values.creator,values.name,values.symbol,values.feeBps);
 need(i.creator!==V33.pauser,'Use a creator account separate from all operator roles');
 need(typeof values.nonce==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(values.nonce)&&BigInt(values.nonce)<=0xffffffffffffffffn,'Invalid market nonce');
 key(n.nonceValue);need(Number.isSafeInteger(n.nonceSlot)&&n.nonceSlot>0,'Invalid nonce slot');
 return Object.freeze({format:'ghost-v33-owner-first-launch-1',network:'mainnet-beta',kind:'launch',programId:V33.programId,candidateHash:V33.binarySha256,deploymentSlot:LIVE_SLOT,creator:i.creator,name:i.name,symbol:i.symbol,feeBps:i.feeBps,nonce:values.nonce,nonceAccount:(await launchNonceAddress()).toBase58(),nonceValue:n.nonceValue,nonceSlot:n.nonceSlot});
}
export async function canonicalLaunch(spec){
 exact(spec,['format','network','kind','programId','candidateHash','deploymentSlot','creator','name','symbol','feeBps','nonce','nonceAccount','nonceValue','nonceSlot']);
 const e=await launchSpec(spec,spec);for(const k of Object.keys(e))need(e[k]===spec[k],'Approval identity mismatch');
 const creator=key(spec.creator),admin=key(V33.admin),nonce=BigInt(spec.nonce),k=marketKeys(context,creator,nonce);
 const tx=new Transaction({feePayer:creator,recentBlockhash:spec.nonceValue}).add(SystemProgram.nonceAdvance({noncePubkey:key(spec.nonceAccount),authorizedPubkey:admin}),ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),create(context,creator,nonce,spec.name,spec.symbol,{feeBps:BigInt(spec.feeBps),approver:admin}));
 const unsigned=Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));
 const signers=tx.signatures.map(s=>s.publicKey.toBase58());need(signers.length===2&&signers[0]===spec.creator&&signers[1]===V33.admin,'Unexpected signer set');
 const summary=Object.freeze({action:'create_market only',network:'mainnet-beta',deploymentSlot:LIVE_SLOT,programId:V33.programId,creator:spec.creator,approver:V33.admin,treasury:V33.treasury,feePayer:spec.creator,signers,name:spec.name,symbol:spec.symbol,feeBps:spec.feeBps,supply:V33.supply,decimals:6,creatorPremint:0,initialBuy:false,market:k.market.toBase58(),mint:k.baseMint.toBase58(),quoteMint:V33.quoteMint,marketNonce:spec.nonce,nonceAccount:spec.nonceAccount,nonceValue:spec.nonceValue,nonceSlot:spec.nonceSlot,privateSettlement:false,assetRegistrationIncluded:false,validity:'Until nonce changes; no ordinary blockhash time limit'});
 return {tx,unsigned,signers,summary,keys:k};
}
export function packLaunch(spec,wire){return {spec,wire:Buffer.from(wire).toString('base64')};}
export async function inspectLaunch(envelope){
 exact(envelope,['spec','wire']);const spec=Object.freeze({...envelope.spec}),v=await canonicalLaunch(spec);
 need(typeof envelope.wire==='string'&&envelope.wire.length<=1644&&/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.wire),'Invalid wire encoding');
 const b=Buffer.from(envelope.wire,'base64');need(b.length<=1232&&b.toString('base64')===envelope.wire,'Noncanonical wire');
 const wire=Uint8Array.from(b),tx=Transaction.from(wire);
 need(sameBytes(tx.serializeMessage(),v.tx.serializeMessage())&&sameBytes(tx.serialize({requireAllSignatures:false,verifySignatures:false}),wire),'Approval message is not canonical');
 let verified=v.unsigned;const signed=[];
 for(let i=0;i<v.signers.length;i++){const sig=wire.subarray(1+64*i,65+64*i);if(sig.every(x=>x===0))continue;const next=Uint8Array.from(verified);next.set(sig,1+64*i);verified=await mergeWalletWire(verified,next,key(v.signers[i]).toBytes());signed.push(v.signers[i]);}
 need(sameBytes(wire,verified),'Unexpected signature bytes');return {...v,spec,wire,signed};
}
