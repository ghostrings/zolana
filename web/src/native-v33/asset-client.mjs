/** Permissionless SPL asset-interface registration; one pinned instruction, wallet pays only rent/fee. */
import {Buffer} from 'buffer';
import {PublicKey,Transaction,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {address} from '@solana/kit';
import {getCreateSplInterfaceInstructionAsync} from '@heliuslabs/spr/instructions';
import {SPP_PROGRAM_ID} from '../../../shared/src/constants.ts';
import {legacyInstructionFields} from '../../../shared/src/tx.ts';
import {readNativeAsset} from '../../../shared/src/native-asset.ts';
import {V33,inspectNativeRelease,decodeV33Market,isKnownNativeRelease} from '../../../shared/src/ghost-markets/v33-release.ts';
import {context,marketKeys} from './instructions.mjs';
import {LIVE_DEPLOYMENT_SLOT} from './launch-policy.mjs';
import {mergeWalletWire} from '../../../protocol/ghost-markets-pilot/wallet/wire.mjs';
import bs58 from 'bs58';
const need=(x,msg)=>{if(!x)throw Error(msg);};
export async function readVerifiedNativeMarket(c,rpc,market){
 const o=await inspectNativeRelease(rpc);need(isKnownNativeRelease(o)&&o.config,'Exact initialized V33 required');const r=await c.getAccountInfoAndContext(new PublicKey(market),{commitment:'finalized',minContextSlot:o.slot}),a=r.value;need(a,'Market not found');
 const m=decodeV33Market(market,{owner:a.owner.toBase58(),executable:a.executable,data:[a.data.toString('base64'),'base64']});const k=marketKeys(context,new PublicKey(m.creator),BigInt(m.nonce));need(k.market.toBase58()===m.address&&k.baseMint.toBase58()===m.baseMint,'Market identity mismatch');return {o,m,slot:r.context.slot};
}
export async function registerAsset({c,rpc,market,wallet,account,maxLamports,approve,onSignature}){
 need(Number.isSafeInteger(maxLamports)&&maxLamports>0&&maxLamports<=100_000_000,'Budget must be 1–100000000 lamports');
 const owner=new PublicKey(account.address),f=wallet?.features?.['solana:signTransaction'];need(wallet.accounts.includes(account)&&account.chains.includes('solana:mainnet')&&account.features.includes('solana:signTransaction')&&f?.supportedTransactionVersions?.includes('legacy'),'Wallet requires legacy sign-only');
 const m=await readVerifiedNativeMarket(c,rpc,market),a=await readNativeAsset(c,m.m.baseMint,m.slot);need(a.state==='registration-available','Asset registration unavailable or restricted; no transaction sent');
 const fields=legacyInstructionFields(await getCreateSplInterfaceInstructionAsync({authority:address(owner.toBase58()),mint:address(m.m.baseMint),tokenProgram:address(TOKEN_PROGRAM_ID.toBase58())}));
 need(fields.programId===SPP_PROGRAM_ID&&fields.keys.some(k=>k.pubkey===m.m.baseMint)&&fields.keys.some(k=>k.pubkey===a.registry)&&fields.keys.filter(k=>k.isSigner).length===1&&fields.keys.some(k=>k.isSigner&&k.pubkey===owner.toBase58()),'Unexpected registry instruction');
 const ix=new TransactionInstruction({programId:new PublicKey(fields.programId),keys:fields.keys.map(k=>({pubkey:new PublicKey(k.pubkey),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(fields.data)});
 const bh=await c.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:owner,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ix),wire=Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));
 const balance=await c.getBalance(owner,'confirmed'),sim=await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{commitment:'confirmed',sigVerify:false,accounts:{encoding:'base64',addresses:[owner.toBase58()]}});
 need(!sim.value.err&&sim.value.accounts?.[0]&&Number.isSafeInteger(sim.value.accounts[0].lamports),'Registration simulation failed');const fee=(await c.getFeeForMessage(tx.compileMessage(),'confirmed')).value;need(Number.isSafeInteger(fee)&&fee>=0,'Fee unavailable');const estimate=Math.max(0,balance-sim.value.accounts[0].lamports)+fee;need(estimate<=maxLamports&&balance>=estimate,'Estimated payer cost exceeds budget');
 need(await approve({mint:m.m.baseMint,registry:a.registry,payer:owner.toBase58(),estimatedDebitLamports:estimate,maximumEstimatedDebitLamports:maxLamports,warning:'Simulation estimate only; not an on-chain debit cap. No deposit, trade or private settlement.'})===true,'Registration cancelled');
 const fresh=await readVerifiedNativeMarket(c,rpc,market);need(fresh.m.baseMint===m.m.baseMint&&(await readNativeAsset(c,m.m.baseMint,fresh.slot)).state==='registration-available','Registration state changed');
 const out=await f.signTransaction({account,chain:'solana:mainnet',transaction:Uint8Array.from(wire)});need(wallet.accounts.includes(account)&&Array.isArray(out)&&out.length===1&&out[0].signedTransaction instanceof Uint8Array,'Wallet response changed');
 const merged=await mergeWalletWire(wire,out[0].signedTransaction,owner.toBytes()),signed=Transaction.from(merged);need(signed.verifySignatures()&&signed.signature,'Invalid registry signature');
 need((await c.getBlockHeight('confirmed'))<=bh.lastValidBlockHeight&&(await c.isBlockhashValid(bh.blockhash,{commitment:'confirmed'})).value,'Blockhash expired; no transaction sent. Check registration and start again.');const signature=bs58.encode(signed.signature);onSignature(signature);
 const actual=await c.sendRawTransaction(signed.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});need(actual===signature,'Unexpected signature');
 // The relay does not expose a WebSocket endpoint; poll signature status.
 const until=Date.now()+120000;while(Date.now()<until){const r=(await c.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(r?.err)throw Error('Registry transaction failed');if(r?.confirmationStatus==='finalized'){const end=await readNativeAsset(c,m.m.baseMint,r.slot);need(end.state==='registered'&&end.slot>=r.slot,'Finalized registry not verified');return {signature,asset:end};}await new Promise(r=>setTimeout(r,1500));}throw Error('Finality not observed; check signature before retry');
}
