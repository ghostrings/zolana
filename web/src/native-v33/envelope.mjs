/** Canonical two-party approval envelope. No keys, RPC or signing in this module.
 * Do not trust a raw transaction from another party: reconstruct the allowed message.
 */
import { Buffer } from 'buffer';
import { PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { context, initialize, create, marketKeys } from './instructions.mjs';
import { V33, launchIntent } from '../../../shared/src/ghost-markets/v33-release.ts';
import { mergeWalletWire, sameBytes } from '../../../protocol/ghost-markets-pilot/wallet/wire.mjs';
const requireThat=(ok,why)=>{if(!ok)throw Error(why);};
const key=x=>new PublicKey(x);
const exact=(o,names)=>{requireThat(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===names.slice().sort().join(','),'Unexpected approval fields');};
const asU64=x=>{requireThat(typeof x==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(x)&&BigInt(x)<=0xffffffffffffffffn,'Invalid nonce');return BigInt(x);};
const from64=s=>{requireThat(typeof s==='string'&&s.length<=1644&&/^[A-Za-z0-9+/]+={0,2}$/.test(s),'Invalid wire encoding');const b=Buffer.from(s,'base64');requireThat(b.length<=1232&&b.toString('base64')===s,'Noncanonical wire');return Uint8Array.from(b);};
export function approvalSpec(kind,values,bh){
 requireThat(typeof bh.blockhash==='string'&&key(bh.blockhash).toBase58()===bh.blockhash&&Number.isSafeInteger(bh.lastValidBlockHeight)&&bh.lastValidBlockHeight>0,'Invalid blockhash context');
 const base={format:'ghost-v33-approval-1',network:'mainnet-beta',programId:V33.programId,candidateHash:V33.binarySha256,kind,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight};
 if(kind==='initialize')return Object.freeze(base);
 requireThat(kind==='launch','Unsupported approval type');const i=launchIntent(values.creator,values.name,values.symbol,Number(values.feeBps));
 const nonce=String(values.nonce);asU64(nonce);
 return Object.freeze({...base,creator:i.creator,name:i.name,symbol:i.symbol,feeBps:i.feeBps,nonce});
}
export function canonicalApproval(spec){
 const common=['format','network','programId','candidateHash','kind','blockhash','lastValidBlockHeight'];
 requireThat(spec?.kind==='initialize'||spec?.kind==='launch','Unsupported approval kind');
 exact(spec,spec.kind==='launch'?[...common,'creator','name','symbol','feeBps','nonce']:common);
 const expected=approvalSpec(spec.kind,spec,spec);
 for(const k of Object.keys(expected))requireThat(spec[k]===expected[k],'Approval identity mismatch');
 const payer=key(spec.kind==='initialize'?V33.upgradeAuthority:spec.creator);
 const ix=spec.kind==='initialize'?initialize(context,payer,key(V33.pauser),key(V33.treasury)):create(context,payer,asU64(spec.nonce),spec.name,spec.symbol,{approver:key(V33.admin),feeBps:BigInt(spec.feeBps)});
 const tx=new Transaction({feePayer:payer,blockhash:spec.blockhash,lastValidBlockHeight:spec.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ix);
 const unsigned=Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));
 const signers=tx.signatures.map(x=>x.publicKey.toBase58());
 requireThat(signers.length===2&&signers.includes(V33.upgradeAuthority)&&signers.includes(spec.kind==='initialize'?V33.treasury:spec.creator),'Unexpected signer set');
 const keys=spec.kind==='launch'?marketKeys(context,payer,asU64(spec.nonce)):null;
 const summary=Object.freeze({action:spec.kind,feePayer:payer.toBase58(),signers:Object.freeze(signers),blockhash:spec.blockhash,lastValidBlockHeight:spec.lastValidBlockHeight,programId:V33.programId,treasury:V33.treasury,pauser:V33.pauser,privateSettlement:false,...(spec.kind==='launch'?{creator:spec.creator,name:spec.name,symbol:spec.symbol,feeBps:String(spec.feeBps),nonce:spec.nonce,market:keys.market.toBase58(),mint:keys.baseMint.toBase58(),approver:V33.admin}:{initialMode:'locked',activationIncluded:false})});
 return {tx,unsigned,signers,summary};
}
export async function inspectApproval(envelope){
 exact(envelope,['spec','wire']);const spec=Object.freeze({...envelope.spec});const canonical=canonicalApproval(spec),wire=from64(envelope.wire),tx=Transaction.from(wire);
 requireThat(sameBytes(tx.serializeMessage(),canonical.tx.serializeMessage())&&sameBytes(tx.serialize({requireAllSignatures:false,verifySignatures:false}),wire),'Approval message is not canonical');
 // Build up the wire from canonical unsigned bytes, verifying each existing Ed25519 signature.
 let verified=canonical.unsigned;const signed=[];
 for(let i=0;i<canonical.signers.length;i++){
   const sig=wire.subarray(1+64*i,65+64*i);if(sig.every(x=>x===0))continue;
   const next=Uint8Array.from(verified);next.set(sig,1+64*i);
   verified=await mergeWalletWire(verified,next,key(canonical.signers[i]).toBytes());signed.push(canonical.signers[i]);
 }
 requireThat(sameBytes(verified,wire),'Unexpected signature bytes');return {spec,wire,signed,summary:canonical.summary};
}
export function packApproval(spec,wire){return {spec,wire:Buffer.from(wire).toString('base64')};}
