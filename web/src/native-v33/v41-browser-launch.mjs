/** Permissionless V41 launch. Uses one wallet signature, no shared nonce, no operator key.
 * Mainnet signing is disabled until the exact V41 release is reviewed and matched on-chain.
 */
import { PublicKey,Transaction,VersionedTransaction,ComputeBudgetProgram,SystemProgram } from '@solana/web3.js';
import { MINT_SIZE,ACCOUNT_SIZE,TOKEN_PROGRAM_ID,unpackMint,unpackAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { V33,inspectNativeRelease,signingAllowed,decodeV33Market } from '../../../shared/src/ghost-markets/v33-release.ts';
import { V41_PROFILE } from '../../../shared/src/ghost-markets/v41-policy.ts';
import { context,marketKeys,createPermissionless } from './instructions.mjs';
import { canonicalUploadedMetadataUri } from './launch-policy.mjs';
import { mergeWalletWire,sameBytes } from '../../../protocol/ghost-markets-pilot/wallet/wire.mjs';
import { observeSignature } from './finality.mjs';
const need=(x,msg)=>{if(!x)throw Error(msg);};
const pk=x=>new PublicKey(x);
export function permissionlessSpec(values){
 const creator=pk(values.creator).toBase58();need(creator===values.creator&&creator!==SystemProgram.programId.toBase58(),'Invalid creator');
 const name=values.name,symbol=values.symbol,feeBps=Number(values.feeBps),nonce=String(values.nonce);
 need(typeof name==='string'&&name.length>0&&new TextEncoder().encode(name).length<=32&&!/\p{Cc}/u.test(name)&&typeof symbol==='string'&&/^[A-Z0-9]{1,10}$/.test(symbol)&&[200,300,400].includes(feeBps),'Invalid launch metadata or fee');
 need(/^\d{1,20}$/.test(nonce)&&BigInt(nonce)<(1n<<64n),'Invalid market seed');
 return Object.freeze({creator,name,symbol,feeBps,nonce,metadataUri:canonicalUploadedMetadataUri(values.metadataUri)});
}
async function guard(rpc){const o=await inspectNativeRelease(rpc);need(o.release==='v41'&&signingAllowed(o,'launch'),'V41 release not verified, approved and active');return o;}
export async function preparePermissionless({c,rpc,spec}){
 spec=permissionlessSpec(spec);const o=await guard(rpc),creator=pk(spec.creator),k=marketKeys(context,creator,BigInt(spec.nonce));
 const [payer,...accounts]=await c.getMultipleAccountsInfo([creator,k.market,k.baseMint,k.lpMint,k.baseVault,k.quoteVault,k.lpLock],'confirmed');
 need(payer&&payer.owner.equals(SystemProgram.programId)&&payer.data.length===0&&!payer.executable&&accounts.every(x=>x===null),'Creator account unavailable or launch addresses already exist');
 const rents=await Promise.all([611,MINT_SIZE,ACCOUNT_SIZE].map(x=>c.getMinimumBalanceForRentExemption(x,'confirmed')));need(rents.every(x=>Number.isSafeInteger(x)&&x>=0),'Rent unavailable');
 const rent=rents[0]+2*rents[1]+3*rents[2],bh=await c.getLatestBlockhash('confirmed');
 const ix=createPermissionless(context,creator,BigInt(spec.nonce),spec.name,spec.symbol,{feeBps:BigInt(spec.feeBps),metadataUri:spec.metadataUri});
 const tx=new Transaction({feePayer:creator,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ix);
 const wire=Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));need(tx.signatures.length===1&&tx.signatures[0].publicKey.equals(creator),'Only the creator may sign');
 const fee=(await c.getFeeForMessage(tx.compileMessage(),'confirmed')).value;need(Number.isSafeInteger(fee)&&fee>=0&&Number.isSafeInteger(payer.lamports)&&payer.lamports>=rent+fee,'Insufficient public SOL for account rent and fee');
 const simulation=await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{sigVerify:false,commitment:'confirmed'});need(simulation.value.err===null,'Launch simulation refused: '+JSON.stringify(simulation.value.err));
 const summary=Object.freeze({network:'mainnet-beta',action:'Public native issuance only',programId:V33.programId,binarySha256:o.binarySha256,deploymentSlot:o.deploymentSlot,creator:spec.creator,signers:[spec.creator],market:k.market.toBase58(),mint:k.baseMint.toBase58(),name:spec.name,symbol:spec.symbol,metadataUri:spec.metadataUri,feeBps:spec.feeBps,supply:V41_PROFILE.supply,virtualQuoteLamports:V41_PROFILE.virtualQuote,graduationQuoteLamports:V41_PROFILE.graduationQuote,nominalGraduationCapLamports:V41_PROFILE.nominalGraduationCap,quoteCapLamports:V41_PROFILE.quoteCap,creatorPremint:0,initialBuy:false,privateSettlement:false,rentEstimateLamports:rent,networkFeeEstimateLamports:fee,totalEstimateLamports:rent+fee});
 return {spec,k,tx,wire,bh,summary};
}
export async function signAndSubmitPermissionless({c,rpc,reviewed,wallet,account,approve,onSignature,stillSelected}){
 need(location.origin==='https://privacycash.fun'&&stillSelected?.()===true,'Select the reviewed creator on the official site');
 const s=reviewed.spec,owner=pk(s.creator),f=wallet?.features?.['solana:signTransaction'];need(account?.address===s.creator&&wallet.accounts.includes(account)&&account.chains.includes('solana:mainnet')&&account.features.includes('solana:signTransaction')&&sameBytes(account.publicKey,owner.toBytes())&&f?.supportedTransactionVersions?.includes('legacy'),'Connect the reviewed creator wallet');
 // Refresh blockhash at the signing step. No file handoff and no second signer.
 const v=await preparePermissionless({c,rpc,spec:s});need(v.summary.binarySha256===reviewed.summary.binarySha256&&v.summary.deploymentSlot===reviewed.summary.deploymentSlot&&v.summary.market===reviewed.summary.market&&v.summary.mint===reviewed.summary.mint,'Release or market identity changed; prepare again');
 need(v.summary.totalEstimateLamports<=reviewed.summary.totalEstimateLamports,'Estimated costs increased; prepare again');
 need(await approve(v.summary)===true&&stillSelected()===true,'Launch cancelled or account changed');
 const out=await f.signTransaction({account,chain:'solana:mainnet',transaction:Uint8Array.from(v.wire)});need(stillSelected()===true&&wallet.accounts.includes(account)&&Array.isArray(out)&&out.length===1&&out[0].signedTransaction instanceof Uint8Array,'Invalid wallet response');
 const merged=await mergeWalletWire(v.wire,out[0].signedTransaction,owner.toBytes()),signed=Transaction.from(merged);need(signed.verifySignatures()&&signed.signature,'Invalid creator signature');
 const end=await guard(rpc);need(end.binarySha256===v.summary.binarySha256&&end.deploymentSlot===v.summary.deploymentSlot,'Deployment changed');
 need((await c.getBlockHeight('confirmed'))<=v.bh.lastValidBlockHeight&&(await c.isBlockhashValid(v.bh.blockhash,{commitment:'confirmed'})).value,'Expired blockhash; no submission. Prepare again.');
 need(stillSelected()===true,'Creator selection changed; no submission');
 const signature=bs58.encode(signed.signature);onSignature(signature);
 try{const actual=await c.sendRawTransaction(signed.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});need(actual===signature,'Unexpected signature');}catch{return {signature,status:'submission uncertain; inspect signature before retry'};}
 const receipt=await observeSignature(c,signature);if(receipt.status!=='finalized')return {signature,...receipt};
 const r=await c.getMultipleAccountsInfoAndContext([v.k.market,v.k.baseMint,v.k.baseVault],{commitment:'finalized',minContextSlot:receipt.slot});const [m,mi,vi]=r.value;need(m,'Market account missing after finality');
 const market=decodeV33Market(v.summary.market,{owner:m.owner.toBase58(),executable:m.executable,data:[m.data.toString('base64'),'base64']});
 const mint=unpackMint(v.k.baseMint,mi,TOKEN_PROGRAM_ID),vault=unpackAccount(v.k.baseVault,vi,TOKEN_PROGRAM_ID);
 need(market.creator===s.creator&&market.baseMint===v.summary.mint&&market.metadataUri===s.metadataUri&&market.name===s.name&&market.symbol===s.symbol&&market.feeBps===s.feeBps&&market.virtualQuote===V41_PROFILE.virtualQuote&&market.graduationQuote===V41_PROFILE.graduationQuote&&mint.decimals===6&&mint.mintAuthority===null&&mint.freezeAuthority===null&&vault.mint.equals(v.k.baseMint)&&vault.owner.equals(v.k.market),'Finalized market identity mismatch; inspect receipt');
 return {signature,status:'finalized',market,slot:r.context.slot,privateSettlement:false};
}
