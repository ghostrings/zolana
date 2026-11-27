/** V36 metadata-bound durable launch; old V35 approval format remains unchanged. */
import { Buffer } from 'buffer';
import { PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, NonceAccount } from '@solana/web3.js';
import { MINT_SIZE, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, unpackMint, unpackAccount } from '@solana/spl-token';
import { V33, launchIntent, inspectNativeRelease, scanV33, decodeV33Market, signingAllowed } from '../../../shared/src/ghost-markets/v33-release.ts';
import { launchSpec, launchNonceAddress } from './launch-nonce-envelope.mjs';
import { context, create, marketKeys } from './instructions.mjs';
import { canonicalUploadedMetadataUri, firstPilotAllowed, LIVE_DEPLOYMENT_SLOT } from './launch-policy.mjs';
import { mergeWalletWire, sameBytes } from '../../../protocol/ghost-markets-pilot/wallet/wire.mjs';
import bs58 from 'bs58';
const need=(x,msg)=>{if(!x)throw Error(msg);};
const key=s=>new PublicKey(s);
const admin=key(V33.admin);
export async function browserLaunchSpec(values,n){
 const v=await launchSpec(values,n);
 return Object.freeze({...v,format:'ghost-v36-browser-launch-1',metadataUri:canonicalUploadedMetadataUri(values.metadataUri)});
}
export async function canonicalBrowserLaunch(spec){
 const v=await browserLaunchSpec(spec,spec);
 need(Object.keys(spec).length===Object.keys(v).length&&Object.entries(v).every(([k,x])=>spec[k]===x),'Approval fields or identity changed');
 const creator=key(spec.creator),nonce=BigInt(spec.nonce),k=marketKeys(context,creator,nonce);
 const tx=new Transaction({feePayer:creator,recentBlockhash:spec.nonceValue}).add(SystemProgram.nonceAdvance({noncePubkey:key(spec.nonceAccount),authorizedPubkey:admin}),ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),create(context,creator,nonce,spec.name,spec.symbol,{feeBps:BigInt(spec.feeBps),approver:admin,metadataUri:spec.metadataUri}));
 const unsigned=Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false})),signers=tx.signatures.map(s=>s.publicKey.toBase58());
 need(signers.length===2&&signers[0]===spec.creator&&signers[1]===V33.admin,'Unexpected signers');
 const summary={action:'Public native issuance only',network:'mainnet-beta',programId:V33.programId,releaseSlot:LIVE_DEPLOYMENT_SLOT,creator:spec.creator,administrator:V33.admin,treasury:V33.treasury,feePayer:spec.creator,name:spec.name,symbol:spec.symbol,metadataUri:spec.metadataUri,feeBps:spec.feeBps,mint:k.baseMint.toBase58(),market:k.market.toBase58(),supply:'1000000 tokens',creatorPremint:0,initialBuy:false,privateSettlement:false,nonceAccount:spec.nonceAccount,nonceValue:spec.nonceValue};
 return {tx,unsigned,signers,summary,keys:k};
}
export function packBrowserLaunch(spec,wire){return {spec,wire:Buffer.from(wire).toString('base64')};}
export async function inspectBrowserLaunch(envelope){
 need(envelope&&typeof envelope==='object'&&Object.keys(envelope).sort().join(',')==='spec,wire','Invalid envelope');
 const spec=Object.freeze({...envelope.spec}),v=await canonicalBrowserLaunch(spec);
 need(typeof envelope.wire==='string'&&envelope.wire.length<=1644&&/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.wire),'Invalid wire');
 const b=Buffer.from(envelope.wire,'base64');need(b.length<=1232&&b.toString('base64')===envelope.wire,'Noncanonical wire');
 const wire=Uint8Array.from(b),t=Transaction.from(wire);need(sameBytes(t.serializeMessage(),v.tx.serializeMessage())&&sameBytes(t.serialize({requireAllSignatures:false,verifySignatures:false}),wire),'Approval message changed');
 let verified=v.unsigned;const signed=[];
 for(let i=0;i<v.signers.length;i++){const sig=wire.subarray(1+i*64,65+i*64);if(sig.every(x=>x===0))continue;const next=Uint8Array.from(verified);next.set(sig,1+i*64);verified=await mergeWalletWire(verified,next,key(v.signers[i]).toBytes());signed.push(v.signers[i]);}
 need(sameBytes(verified,wire),'Unexpected signature bytes');return {...v,spec,wire,signed};
}
export async function nativeLaunchState(rpc){
 const o=await inspectNativeRelease(rpc);need(o.release==='v33'&&o.deploymentSlot===LIVE_DEPLOYMENT_SLOT&&o.config?.mode==='active','Exact active V33 deployment required');
 const scan=await scanV33(rpc);need(firstPilotAllowed(o,scan,V33)||signingAllowed(o,'launch'),'Only the single owner-approved pilot is eligible pending independent review');return {o,scan};
}
export async function readLaunchNonce(c,commitment='finalized',minContextSlot){
 const addr=await launchNonceAddress(),r=await c.getAccountInfoAndContext(addr,{commitment,...(minContextSlot===undefined?{}:{minContextSlot})}),a=r.value;
 need(a&&a.owner.equals(SystemProgram.programId)&&!a.executable&&a.data.length===80&&a.data.readUInt32LE(0)===1&&a.data.readUInt32LE(4)===1,'Existing initialized nonce account required');
 const n=NonceAccount.fromAccountData(a.data);need(n.authorizedPubkey.equals(admin),'Nonce authority mismatch');return {nonceAccount:addr.toBase58(),nonceValue:n.nonce,nonceSlot:r.context.slot};
}
export async function launchPreflight(c,rpc,v){
 await nativeLaunchState(rpc);const n=await readLaunchNonce(c,'confirmed',v.spec.nonceSlot);need(n.nonceAccount===v.spec.nonceAccount&&n.nonceValue===v.spec.nonceValue,'Nonce changed; discard approval and check chain');
 const infos=await c.getMultipleAccountsInfo([v.keys.market,v.keys.baseMint,v.keys.lpMint,v.keys.baseVault,v.keys.quoteVault,v.keys.lpLock],'confirmed');need(infos.every(x=>x===null),'Launch accounts already exist');
 const rents=await Promise.all([611,MINT_SIZE,ACCOUNT_SIZE].map(x=>c.getMinimumBalanceForRentExemption(x,'confirmed')));need(rents.every(x=>Number.isSafeInteger(x)&&x>=0),'Rent unavailable');
 const rent=rents[0]+2*rents[1]+3*rents[2],fee=(await c.getFeeForMessage(v.tx.compileMessage(),'confirmed')).value,balance=await c.getBalance(key(v.spec.creator),'confirmed');
 need(Number.isSafeInteger(fee)&&fee>=0&&Number.isSafeInteger(balance)&&balance>=rent+fee,'Insufficient creator SOL or fee unavailable');return {creatorRentEstimateLamports:rent,networkFeeEstimateLamports:fee,creatorBalanceLamports:balance};
}
export async function signBrowserLaunch(v,wallet,account){
 need(v.signers.includes(account.address)&&!v.signed.includes(account.address),'Select an unsigned required signer');const f=wallet?.features?.['solana:signTransaction'];
 need(wallet.accounts.includes(account)&&account.chains.includes('solana:mainnet')&&account.features.includes('solana:signTransaction')&&sameBytes(account.publicKey,key(account.address).toBytes())&&f?.supportedTransactionVersions?.includes('legacy'),'Wallet must support mainnet legacy sign-only');
 const out=await f.signTransaction({account,chain:'solana:mainnet',transaction:Uint8Array.from(v.wire)});need(wallet.accounts.includes(account)&&Array.isArray(out)&&out.length===1&&out[0].signedTransaction instanceof Uint8Array,'Invalid wallet response');
 return inspectBrowserLaunch(packBrowserLaunch(v.spec,await mergeWalletWire(v.wire,out[0].signedTransaction,account.publicKey)));
}
export async function sendBrowserLaunch(c,rpc,v,onSignature){
 need(v.signed.length===2,'Both signatures required');await launchPreflight(c,rpc,v);const tx=Transaction.from(v.wire);need(tx.verifySignatures()&&tx.signature,'Invalid transaction signatures');const signature=bs58.encode(tx.signature);onSignature(signature);
 // No automatic retry; verify the expected signature after any uncertain network response.
 const actual=await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0,minContextSlot:v.spec.nonceSlot});need(actual===signature,'Unexpected RPC signature');
 const until=Date.now()+120000;while(Date.now()<until){const s=(await c.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(s?.err)throw Error('Launch failed: '+JSON.stringify(s.err));if(s?.confirmationStatus==='finalized'){
 const read=await c.getAccountInfoAndContext(v.keys.market,'finalized'),a=read.value;need(a,'Finalized market missing');const market=decodeV33Market(v.summary.market,{owner:a.owner.toBase58(),executable:a.executable,data:[a.data.toString('base64'),'base64']});
 need(market.creator===v.spec.creator&&market.baseMint===v.summary.mint&&market.name===v.spec.name&&market.symbol===v.spec.symbol&&market.metadataUri===v.spec.metadataUri&&market.feeBps===v.spec.feeBps,'Market identity mismatch');
 const [mi,vi]=await c.getMultipleAccountsInfo([v.keys.baseMint,v.keys.baseVault],'finalized'),mint=unpackMint(v.keys.baseMint,mi,TOKEN_PROGRAM_ID),vault=unpackAccount(v.keys.baseVault,vi,TOKEN_PROGRAM_ID);need(mint.decimals===6&&mint.mintAuthority===null&&mint.freezeAuthority===null&&vault.mint.equals(v.keys.baseMint)&&vault.owner.equals(v.keys.market),'Mint/vault verification failed');return {signature,market,slot:read.context.slot,privateSettlement:false};}
 await new Promise(r=>setTimeout(r,1500));}throw Error('Finality not observed; check expected signature before retry');
}
