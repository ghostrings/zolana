/** Public-SPL browser client for the exact V33 release. V39 permits the owner-authorized,
 * unaudited market operations only; independent approval remains separate. Every action
 * fails closed on an unexpected deployment/configuration. No key generation or custody.
 */
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { createReadRpc } from '../../../shared/src/ghost-markets/observe.ts';
import { V33, inspectNativeRelease, signingAllowed, launchIntent } from '../../../shared/src/ghost-markets/v33-release.ts';
import { Connection, PublicKey, Transaction, VersionedTransaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ACCOUNT_SIZE, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, unpackAccount, unpackMint } from '@solana/spl-token';
import { context as ctx, marketKeys, create, swapIx, graduateIx, claimFeesIx } from './instructions.mjs';
import { PROFILE } from '../../../protocol/ghost-markets-pilot/reference/pilot-profile.mjs';
import { readFeeLedger } from '../../../protocol/ghost-markets-pilot/reference/native-fees.mjs';
import { assertLaunch } from '../../../protocol/ghost-markets-pilot/lab/core.mjs';
import { marketState, quoteAction, beneficiaryOwed } from './market-profile.mjs';
import { approvalSpec, canonicalApproval, inspectApproval, packApproval } from './envelope.mjs';
import {observeSignature} from './finality.mjs';
import {tradeFundingEstimate} from './trade-funding.mjs';
import { mergeWalletWire, sameBytes } from '../../../protocol/ghost-markets-pilot/wallet/wire.mjs';

const key = value => new PublicKey(value);
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const ata = (owner, mint) => getAssociatedTokenAddressSync(mint, owner);
const openAta = (payer, owner, mint) => createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);
const at = (data, offset) => key(data.subarray(offset, offset + 32));

/** Uses the site's existing same-origin RPC. No caller-provided RPC URL or program ID. */
export function stagedV33Client() {
 requireThat(location.origin==='https://privacycash.fun','Mainnet signing is restricted to the canonical HTTPS site');
 const endpoint=new URL('/api/helius',location.origin).href;
 const rpc=createReadRpc(endpoint),c=new Connection(endpoint,'finalized');
 const pending=new WeakMap();
 async function guard(action){
   const observation=await inspectNativeRelease(rpc);
   requireThat(signingAllowed(observation,action),'V33 action is not authorized or the deployment/state changed');
   return observation;
 }
 async function config(action,observation){const o=observation??await guard(action),cfg=o.config;return {mode:cfg.mode==='active'?1:2,admin:key(cfg.admin),pauser:key(cfg.pauser),treasury:key(cfg.treasury),slot:o.slot};}
 async function readMarket(address,action,observation){
   const cfg=await config(action,observation),market=key(address),r=await c.getAccountInfoAndContext(market,{commitment:'finalized',minContextSlot:cfg.slot}),a=r.value;requireThat(r.context.slot>=cfg.slot&&a?.owner.equals(ctx.pid)&&!a.executable,'Market missing or snapshot stale');
   const d=a.data,s=marketState(d),fees=readFeeLedger(d),creator=at(d,11),nonce=d.readBigUInt64LE(43),k=marketKeys(ctx,creator,nonce),treasury=at(d,309);
   requireThat(market.equals(k.market)&&[[51,k.baseMint],[83,k.quoteMint],[115,k.lpMint],[147,k.baseVault],[179,k.quoteVault],[211,k.lpLock]].every(([offset,p])=>at(d,offset).equals(p)),'Market PDA mismatch');
   requireThat(treasury.equals(cfg.treasury),'Unexpected pinned treasury');
   const vaultRead=await c.getMultipleAccountsInfoAndContext([k.baseVault,k.quoteVault,k.lpLock,k.baseMint,k.lpMint],{commitment:'finalized',minContextSlot:r.context.slot}),infos=vaultRead.value;
   requireThat(vaultRead.context.slot>=r.context.slot&&infos.length===5,'Vault snapshot unavailable or stale');
   const [b,q,l]=[k.baseVault,k.quoteVault,k.lpLock].map((x,i)=>unpackAccount(x,infos[i],TOKEN_PROGRAM_ID));
   const bm=unpackMint(k.baseMint,infos[3],TOKEN_PROGRAM_ID),lm=unpackMint(k.lpMint,infos[4],TOKEN_PROGRAM_ID);
   requireThat([b,q,l].every(x=>x.owner.equals(market)&&!x.isFrozen)&&b.mint.equals(k.baseMint)&&q.mint.equals(NATIVE_MINT)&&l.mint.equals(k.lpMint)&&b.amount>=s.base&&q.amount>=s.quote+fees.platform+fees.creator,'Vault accounting mismatch');
   requireThat(bm.decimals===6&&bm.mintAuthority===null&&bm.freezeAuthority===null&&bm.supply<=PROFILE.supply-d.readBigUInt64LE(293)&&bm.supply>=b.amount,'Unexpected base mint');
   requireThat(lm.decimals===6&&lm.mintAuthority?.equals(market)&&lm.supply===l.amount&&l.amount===d.readBigUInt64LE(301),'Unexpected LP lock');
   return {cfg,k,s,fees,creator,treasury,lpSupply:lm.supply,lpLocked:l.amount};
 }
 async function readTradeFunding(owner, mint, action, amountIn, feeLamports){
   const base=ata(owner,mint),wsol=ata(owner,NATIVE_MINT);
   const [payer,b,w]=await c.getMultipleAccountsInfo([owner,base,wsol],'confirmed');
   requireThat(payer&&payer.owner.equals(SystemProgram.programId)&&!payer.executable&&payer.data.length===0,'Public fee payer must be a funded system wallet');
   function verifyAta(info,address,expectedMint,native){
     if(!info)return 0n;const t=unpackAccount(address,info,TOKEN_PROGRAM_ID);
     requireThat(t.isInitialized&&t.owner.equals(owner)&&t.mint.equals(expectedMint)&&!t.isFrozen&&t.isNative===native,'Unexpected wallet token account');return t.amount;
   }
   const tokens=verifyAta(b,base,mint,false);verifyAta(w,wsol,NATIVE_MINT,true);
   const missingAtaCount=Number(!b)+Number(!w),ataRentLamports=missingAtaCount?await c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE,'confirmed'):0;
   return tradeFundingEstimate({action,amountIn,solBalance:payer.lamports,tokenBalance:tokens,missingAtaCount,ataRentLamports,feeLamports});
 }
 async function draft(payer,instructions,summary){
   const observation=await guard(summary.action);requireThat(!['initialize','launch'].includes(summary.action)||observation.release==='v33','Use the V41 one-wallet launch form');const bh=await c.getLatestBlockhash('confirmed');
   const tx=new Transaction({feePayer:payer,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),...instructions);
   const wire=Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));
   const signers=tx.signatures.map(x=>x.publicKey.toBase58());
   if(['buy','sell','graduate','claim'].includes(summary.action))requireThat(signers.length===1&&signers[0]===payer.toBase58(),'Market operation must use one wallet signer');
   const fee=(await c.getFeeForMessage(tx.compileMessage(),'confirmed')).value;
   requireThat(Number.isSafeInteger(fee)&&fee>=0,'Network fee unavailable');
   const funding=['buy','sell'].includes(summary.action)?await readTradeFunding(payer,key(summary.mint),summary.action,BigInt(summary.amountIn),fee):null;
   let simulation=null;
   if(['buy','sell','graduate','claim'].includes(summary.action)){
     const sim=await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{commitment:'confirmed',sigVerify:false});
     requireThat(sim.value.err===null,'Public transaction simulation refused; obtain a fresh quote or check wallet balances');
     simulation={result:'passed at confirmed commitment',slot:sim.context.slot,unitsConsumed:sim.value.unitsConsumed??null};
   }
   const handle=Object.freeze({summary:Object.freeze({...summary,feePayer:payer.toBase58(),signers:Object.freeze(signers),blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight,feeLamports:fee,funding,simulation})});
   let spec=null;if(summary.action==='launch'){spec=approvalSpec('launch',summary,bh);requireThat(sameBytes(canonicalApproval(spec).unsigned,wire),'Canonical launch mismatch');}
   pending.set(handle,{wire,bh,spec,releaseIdentity:[observation.binarySha256,observation.deploymentSlot],signed:new Set(),submitted:false,busy:false});return handle;
 }
 async function launch({creator,nonce,name,symbol,feeBps}){
   launchIntent(creator,name,symbol,Number(feeBps));
   const payer=key(creator),cfg=await config('launch');requireThat(cfg.mode===1&&!payer.equals(cfg.admin)&&!payer.equals(cfg.treasury),'Launch not authorized');
   const details=assertLaunch({name,symbol,feeBps:String(feeBps)}),k=marketKeys(ctx,payer,nonce);requireThat(!(await c.getAccountInfo(k.market,'finalized')),'Market already exists');
   return draft(payer,[create(ctx,payer,nonce,details.name,details.symbol,{approver:cfg.admin,feeBps:details.feeBps})],{action:'launch',creator:payer.toBase58(),approver:cfg.admin.toBase58(),treasury:cfg.treasury.toBase58(),market:k.market.toBase58(),mint:k.baseMint.toBase58(),name,symbol,feeBps:String(feeBps),nonce:String(nonce),privateSettlement:false});
 }
 async function initialization(){
   await guard('initialize');const bh=await c.getLatestBlockhash('finalized'),spec=approvalSpec('initialize',{},bh),v=canonicalApproval(spec);
   const handle=Object.freeze({summary:Object.freeze({...v.summary,feeLamports:(await c.getFeeForMessage(v.tx.compileMessage(),'finalized')).value})});
   pending.set(handle,{wire:v.unsigned,bh,spec,signed:new Set(),submitted:false,busy:false});return handle;
 }
 async function trade({wallet,market,action,amount,version}){
   requireThat(action==='buy'||action==='sell','Use buy or sell');const owner=key(wallet),r=await readMarket(market,action);
   const quote=quoteAction(r.s,r.lpSupply,r.lpLocked,r.cfg.mode,{action,amount,version},r.fees),buy=action==='buy';
   const base=ata(owner,r.k.baseMint),wsol=ata(owner,NATIVE_MINT),instructions=[openAta(owner,owner,r.k.baseMint),openAta(owner,owner,NATIVE_MINT)];
   if(buy){ // Always explicit native SOL input; never automatically close a pre-existing WSOL account.
     requireThat(quote.amountIn<=BigInt(Number.MAX_SAFE_INTEGER),'SOL input too large');
     instructions.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:wsol,lamports:Number(quote.amountIn)}),createSyncNativeInstruction(wsol));
   }
   const deadline=BigInt(await c.getSlot('confirmed'))+150n;
   instructions.push(swapIx(ctx,r.k,owner,base,wsol,{buy,amountIn:quote.amountIn,minimumOut:quote.minimumOut,version:r.s.version,deadline}));
   return draft(owner,instructions,{action,market:r.k.market.toBase58(),mint:r.k.baseMint.toBase58(),wallet:owner.toBase58(),amountIn:String(quote.amountIn),minimumOut:String(quote.minimumOut),fee:String(quote.fee),platformFee:String(quote.platformFee),creatorFee:String(quote.creatorFee),version:String(r.s.version),deadline:String(deadline),output:buy?'public SPL token ATA':'public WSOL ATA',privateSettlement:false});
 }
 async function claim({wallet,market}){
   const owner=key(wallet),r=await readMarket(market,'claim');requireThat(r.cfg.mode===1||r.cfg.mode===2,'Claims unavailable');
   requireThat(owner.equals(r.creator)||owner.equals(r.treasury),'Not an authorized beneficiary');
   const owed=beneficiaryOwed(owner.toBase58(),r.creator.toBase58(),r.treasury.toBase58(),r.fees);requireThat(owed>0n,'No fees owed');
   return draft(owner,[openAta(owner,owner,NATIVE_MINT),claimFeesIx(ctx,r.k,owner,ata(owner,NATIVE_MINT))],{action:'claim',market:r.k.market.toBase58(),wallet:owner.toBase58(),observedOwed:String(owed),destination:ata(owner,NATIVE_MINT).toBase58(),privateSettlement:false});
 }
 async function graduation({wallet,market}){
   const owner=key(wallet),r=await readMarket(market,'graduate'),q=quoteAction(r.s,r.lpSupply,r.lpLocked,r.cfg.mode,{action:'graduate',version:String(r.s.version)},r.fees),deadline=BigInt(await c.getSlot('confirmed'))+150n;
   return draft(owner,[graduateIx(ctx,r.k,r.s.version,deadline)],{action:'graduate',market:r.k.market.toBase58(),burned:String(q.baseToBurn),lockedLp:String(q.lockedLp),version:String(r.s.version),deadline:String(deadline),privateSettlement:false});
 }
 function record(handle){const r=pending.get(handle);requireThat(r&&!r.submitted&&!r.busy,'Unknown, busy or already submitted draft');return r;}
 async function fresh(handle,r){
   const observation=await guard(handle.summary.action);if(r.releaseIdentity)requireThat(r.releaseIdentity[0]===observation.binarySha256&&r.releaseIdentity[1]===observation.deploymentSlot,'Deployment changed; rebuild quote');if(['initialize','launch'].includes(handle.summary.action))requireThat(observation.release==='v33','Legacy approval not valid on V41');const height=await c.getBlockHeight('confirmed');
   requireThat(Number.isSafeInteger(height)&&height<=r.bh.lastValidBlockHeight,'Blockhash expired; discard and rebuild');const valid=await c.isBlockhashValid(r.bh.blockhash,{commitment:'confirmed'});
   requireThat(valid.value,'Blockhash no longer valid; discard and rebuild');
   const summary=handle.summary;
   if(summary.action==='launch'){requireThat(!(await c.getAccountInfo(key(summary.market),'finalized')),'Market already created');}
   if(['buy','sell','graduate'].includes(summary.action)){
     const m=await readMarket(summary.market,summary.action,observation);
     requireThat(String(m.s.version)===summary.version&&BigInt(await c.getSlot('confirmed'))<=BigInt(summary.deadline),'Quote expired or changed; rebuild');
     if(summary.action==='buy'||summary.action==='sell'){
       requireThat(m.k.baseMint.toBase58()===summary.mint,'Market mint changed');
       const current=await readTradeFunding(key(summary.wallet),m.k.baseMint,summary.action,BigInt(summary.amountIn),summary.feeLamports);
       requireThat(BigInt(current.estimatedTotalSolDebitLamports)<=BigInt(summary.funding.estimatedTotalSolDebitLamports),'Estimated debit increased; rebuild and review');
     }
   }
   if(summary.action==='claim'){const m=await readMarket(summary.market,'claim',observation);const owed=beneficiaryOwed(summary.wallet,m.creator.toBase58(),m.treasury.toBase58(),m.fees);requireThat(String(owed)===summary.observedOwed,'Claim amount changed; rebuild');}
 }
 // Sign-only wallet boundary. The selected account must support mainnet legacy signing.
 async function sign(handle,wallet,account){
   const r=record(handle);r.busy=true;
   try{
     await fresh(handle,r);
     const signer=key(account.address);requireThat(sameBytes(account.publicKey,signer.toBytes())&&handle.summary.signers.includes(account.address)&&!r.signed.has(account.address),'Unexpected signer');
     const feature=wallet?.features?.['solana:signTransaction'];
     requireThat(wallet.accounts.includes(account)&&account.chains.includes('solana:mainnet')&&account.features.includes('solana:signTransaction')&&feature?.supportedTransactionVersions?.includes('legacy')&&typeof feature.signTransaction==='function','Wallet does not support legacy mainnet signing');
     const output=await feature.signTransaction({account,chain:'solana:mainnet',transaction:Uint8Array.from(r.wire)});
     requireThat(wallet.accounts.includes(account)&&Array.isArray(output)&&output.length===1&&output[0].signedTransaction instanceof Uint8Array,'Wallet account or response changed');
     const checked=await mergeWalletWire(r.wire,output[0].signedTransaction,signer.toBytes());
     await fresh(handle,r);r.wire=checked;r.signed.add(account.address);return Array.from(r.signed);
   } finally {r.busy=false;}
 }
 // Explicit user action only. No automatic retry or relayer; expected signature is reported even on uncertain RPC result.
 async function submit(handle,confirmExpectedSignature){
   const r=record(handle);r.busy=true;
   try{
     requireThat(handle.summary.signers.every(s=>r.signed.has(s)),'Required wallet approval missing');await fresh(handle,r);
     const tx=Transaction.from(r.wire);requireThat(tx.verifySignatures()&&tx.signature,'Invalid signature set');
     const expected=bs58.encode(tx.signature);
     requireThat(await confirmExpectedSignature(expected)===true,'Submission cancelled');await fresh(handle,r);
     r.submitted=true;
     try{const actual=await c.sendRawTransaction(r.wire,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});requireThat(actual===expected,'Unexpected RPC signature');return {signature:expected,...await observeSignature(c,expected)};}
     catch{return {signature:expected,status:'submission uncertain; check signature before any retry'};}
   }finally{r.busy=false;}
 }
 async function exportApproval(handle){const r=record(handle);requireThat(r.spec,'Only launch and initialization support portable approval');await fresh(handle,r);return packApproval(r.spec,r.wire);}
 async function importApproval(envelope,previous=null){
   const v=await inspectApproval(envelope);const bh={blockhash:v.spec.blockhash,lastValidBlockHeight:v.spec.lastValidBlockHeight};
   const handle=Object.freeze({summary:v.summary}),r={wire:v.wire,bh,spec:v.spec,signed:new Set(v.signed),submitted:false,busy:false};
   if(previous){const old=record(previous);requireThat(old.spec&&JSON.stringify(old.spec)===JSON.stringify(v.spec),'Approval is not for the current draft');
     let merged=old.wire;for(let i=0;i<v.summary.signers.length;i++){
       const signer=v.summary.signers[i],sig=v.wire.subarray(1+64*i,65+64*i);
       if(old.signed.has(signer)){requireThat(sameBytes(sig,old.wire.subarray(1+64*i,65+64*i)),'Existing approval changed');continue;}
       if(!v.signed.includes(signer))continue;const copy=Uint8Array.from(merged);copy.set(sig,1+64*i);merged=await mergeWalletWire(merged,copy,key(signer).toBytes());
     }
     requireThat(sameBytes(merged,v.wire),'Approval mismatch');await fresh(handle,r);old.submitted=true;
   } else await fresh(handle,r);
   pending.set(handle,r);return {handle,signed:v.signed};
 }
 return Object.freeze({initialization,launch,trade,claim,graduation,sign,submit,exportApproval,importApproval});
}
