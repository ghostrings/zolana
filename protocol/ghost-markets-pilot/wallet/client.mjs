/** V33 wallet integration candidate. Public SPL, fresh loopback validator only.
 * This is not imported by the production transaction routes. No key generation, custody,
 * transaction submission, governance activation or private settlement in this module.
 */
import { Connection, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, unpackAccount, unpackMint } from '@solana/spl-token';
import { localContext, marketKeys, create, swapIx, graduateIx, claimFeesIx } from '../reference/pilot-instructions.mjs';
import { PROFILE } from '../reference/pilot-profile.mjs';
import { readFeeLedger } from '../reference/native-fees.mjs';
import { marketState, protocolMode, quoteAction, assertLaunch } from '../lab/core.mjs';
import { mergeWalletWire, sameBytes } from './wire.mjs';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PUBLIC_GENESIS = new Set(['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','EtWTRABZaYq6iMfeYKouRu166VU2xqa1','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);
const key = value => new PublicKey(value);
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const ata = (owner, mint) => getAssociatedTokenAddressSync(mint, owner);
const openAta = (payer, owner, mint) => createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);
const at = (data, offset) => key(data.subarray(offset, offset + 32));

/** Construct a client bound to a specific local executable, not an arbitrary transaction provider. */
export async function localWalletClient({rpcUrl, programId, executableBytes}) {
 const ctx=localContext(rpcUrl,programId), c=new Connection(ctx.rpcUrl,'confirmed');
 const genesis=await c.getGenesisHash(); requireThat(!PUBLIC_GENESIS.has(genesis),'Public cluster refused');
 const binary=Uint8Array.from(executableBytes); requireThat(binary.length>4&&binary.length<2*1024*1024,'Expected local SBF executable');
 const [programData]=PublicKey.findProgramAddressSync([ctx.pid.toBuffer()],LOADER);
 const [protocol]=PublicKey.findProgramAddressSync([Buffer.from('protocol')],ctx.pid);
 async function guard(){
   requireThat(await c.getGenesisHash()===genesis,'Local ledger changed');
   const [p,d]=await c.getMultipleAccountsInfo([ctx.pid,programData],'confirmed');
   requireThat(p?.executable&&p.owner.equals(LOADER)&&p.data.length===36&&p.data.readUInt32LE(0)===2&&at(p.data,4).equals(programData),'Unexpected executable');
   requireThat(d?.owner.equals(LOADER)&&!d.executable&&d.data.length>=45+binary.length&&d.data.readUInt32LE(0)===3&&d.data[12]===1&&sameBytes(d.data.subarray(45,45+binary.length),binary)&&d.data.subarray(45+binary.length).every(x=>x===0),'Executable changed or wrong local binary');
 }
 await guard();
 async function config(){await guard();const a=await c.getAccountInfo(protocol,'confirmed');requireThat(a?.owner.equals(ctx.pid)&&!a.executable,'Protocol missing');const d=a.data,mode=protocolMode(d),admin=at(d,11),pauser=at(d,43),treasury=at(d,107);requireThat(!treasury.equals(admin)&&!treasury.equals(pauser)&&!treasury.equals(PublicKey.default),'Invalid authorities');return {mode,admin,pauser,treasury};}
 async function readMarket(address){
   const cfg=await config(),market=key(address),a=await c.getAccountInfo(market,'confirmed');requireThat(a?.owner.equals(ctx.pid)&&!a.executable,'Market missing');
   const d=a.data,s=marketState(d),fees=readFeeLedger(d),creator=at(d,11),nonce=d.readBigUInt64LE(43),k=marketKeys(ctx,creator,nonce),treasury=at(d,309);
   requireThat(market.equals(k.market)&&[[51,k.baseMint],[83,k.quoteMint],[115,k.lpMint],[147,k.baseVault],[179,k.quoteVault],[211,k.lpLock]].every(([offset,p])=>at(d,offset).equals(p)),'Market PDA mismatch');
   requireThat(treasury.equals(cfg.treasury),'Unexpected pinned treasury');
   const infos=await c.getMultipleAccountsInfo([k.baseVault,k.quoteVault,k.lpLock,k.baseMint,k.lpMint],'confirmed');
   const [b,q,l]=[k.baseVault,k.quoteVault,k.lpLock].map((x,i)=>unpackAccount(x,infos[i],TOKEN_PROGRAM_ID));
   const bm=unpackMint(k.baseMint,infos[3],TOKEN_PROGRAM_ID),lm=unpackMint(k.lpMint,infos[4],TOKEN_PROGRAM_ID);
   requireThat([b,q,l].every(x=>x.owner.equals(market)&&!x.isFrozen)&&b.mint.equals(k.baseMint)&&q.mint.equals(NATIVE_MINT)&&l.mint.equals(k.lpMint)&&b.amount>=s.base&&q.amount>=s.quote+fees.platform+fees.creator,'Vault accounting mismatch');
   requireThat(bm.decimals===6&&bm.mintAuthority===null&&bm.freezeAuthority===null&&bm.supply<=PROFILE.supply-d.readBigUInt64LE(293)&&bm.supply>=b.amount,'Unexpected base mint');
   requireThat(lm.decimals===6&&lm.mintAuthority?.equals(market)&&lm.supply===l.amount&&l.amount===d.readBigUInt64LE(301),'Unexpected LP lock');
   return {cfg,k,s,fees,creator,treasury,lpSupply:lm.supply,lpLocked:l.amount};
 }
 async function balanceOf(address, owner, mint){const a=await c.getAccountInfo(address,'confirmed');if(!a)return 0n;const t=unpackAccount(address,a,TOKEN_PROGRAM_ID);requireThat(t.owner.equals(owner)&&t.mint.equals(mint)&&!t.isFrozen,'Unexpected wallet token account');return t.amount;}
 async function draft(payer,instructions,summary){await guard();const bh=await c.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:payer,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),...instructions);return {tx,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight,summary};}
 async function launch({creator,nonce,name,symbol,feeBps}){
   const payer=key(creator),cfg=await config();requireThat(cfg.mode===1&&!payer.equals(cfg.admin)&&!payer.equals(cfg.treasury),'Launch not authorized');
   const details=assertLaunch({name,symbol,feeBps:String(feeBps)}),k=marketKeys(ctx,payer,nonce);requireThat(!(await c.getAccountInfo(k.market,'confirmed')),'Market already exists');
   return draft(payer,[create(ctx,payer,nonce,details.name,details.symbol,{approver:cfg.admin,feeBps:details.feeBps})],{action:'launch',creator:payer.toBase58(),approver:cfg.admin.toBase58(),treasury:cfg.treasury.toBase58(),market:k.market.toBase58(),mint:k.baseMint.toBase58(),name,symbol,feeBps:String(feeBps),nonce:String(nonce),privateSettlement:false});
 }
 async function trade({wallet,market,action,amount,version}){
   const owner=key(wallet),r=await readMarket(market);requireThat(action==='buy'||action==='sell','Use buy or sell');
   const quote=quoteAction(r.s,r.lpSupply,r.lpLocked,r.cfg.mode,{action,amount,version},r.fees),buy=action==='buy';
   const base=ata(owner,r.k.baseMint),wsol=ata(owner,NATIVE_MINT),instructions=[openAta(owner,owner,r.k.baseMint),openAta(owner,owner,NATIVE_MINT)];
   if(buy){ // Always explicit native SOL input; never automatically close a pre-existing WSOL account.
     requireThat(quote.amountIn<=BigInt(Number.MAX_SAFE_INTEGER),'SOL input too large');
     instructions.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:wsol,lamports:Number(quote.amountIn)}),createSyncNativeInstruction(wsol));
   }else requireThat(await balanceOf(base,owner,r.k.baseMint)>=quote.amountIn,'Insufficient public token balance');
   const deadline=BigInt(await c.getSlot('confirmed'))+100n;
   instructions.push(swapIx(ctx,r.k,owner,base,wsol,{buy,amountIn:quote.amountIn,minimumOut:quote.minimumOut,version:r.s.version,deadline}));
   return draft(owner,instructions,{action,market:r.k.market.toBase58(),wallet:owner.toBase58(),amountIn:String(quote.amountIn),minimumOut:String(quote.minimumOut),fee:String(quote.fee),platformFee:String(quote.platformFee),creatorFee:String(quote.creatorFee),version:String(r.s.version),deadline:String(deadline),output:buy?'public SPL token ATA':'public WSOL ATA',privateSettlement:false});
 }
 async function claim({wallet,market}){
   const owner=key(wallet),r=await readMarket(market);requireThat(r.cfg.mode===1||r.cfg.mode===2,'Claims unavailable');
   requireThat(owner.equals(r.creator)||owner.equals(r.treasury),'Not an authorized beneficiary');
   const owed=owner.equals(r.treasury)?r.fees.platform:r.fees.creator;requireThat(owed>0n,'No fees owed');
   return draft(owner,[openAta(owner,owner,NATIVE_MINT),claimFeesIx(ctx,r.k,owner,ata(owner,NATIVE_MINT))],{action:'claim',market:r.k.market.toBase58(),wallet:owner.toBase58(),observedOwed:String(owed),destination:ata(owner,NATIVE_MINT).toBase58(),privateSettlement:false});
 }
 async function graduation({wallet,market}){
   const owner=key(wallet),r=await readMarket(market),q=quoteAction(r.s,r.lpSupply,r.lpLocked,r.cfg.mode,{action:'graduate',version:String(r.s.version)},r.fees),deadline=BigInt(await c.getSlot('confirmed'))+100n;
   return draft(owner,[graduateIx(ctx,r.k,r.s.version,deadline)],{action:'graduate',market:r.k.market.toBase58(),burned:String(q.baseToBurn),lockedLp:String(q.lockedLp),privateSettlement:false});
 }
 return Object.freeze({config,readMarket,launch,trade,claim,graduation,guard});
}
/** The caller's wallet must approve the displayed intent. Callback receives wire bytes only.
 * The signed message and other signature slots may not change. No secret crosses this API. */
export async function signPrepared(draft, signer, walletSignTransaction){
 const original=Uint8Array.from(draft.tx.serialize({requireAllSignatures:false,verifySignatures:false}));
 const returned=await walletSignTransaction(Uint8Array.from(original));
 const wire=await mergeWalletWire(original,returned,key(signer).toBytes());
 return {...draft,tx:Transaction.from(wire)};
}
