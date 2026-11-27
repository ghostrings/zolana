/** Separate wallet signatures against a fresh local V33 public-pilot deployment. */
import test from 'node:test';import assert from 'node:assert/strict';import { readFileSync, realpathSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT,getAssociatedTokenAddressSync,getAccount,getMint } from '@solana/spl-token';
import { localContext,marketKeys,initialize,setMode } from '../reference/pilot-instructions.mjs';
import { localWalletClient,signPrepared } from '../wallet/client.mjs';
import { grossForNet } from '../reference/native-fees.mjs';
import { PROFILE } from '../reference/pilot-profile.mjs';
const text=readFileSync(new URL('../Anchor.toml',import.meta.url),'utf8');
const id=text.match(/^ghost_markets\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"\s*$/m)?.[1];
const fmt=(n,d)=>{const s=String(n).padStart(d+1,'0');return `${s.slice(0,-d)}.${s.slice(-d)}`;};
test('V33 independently signed wallet lifecycle (local only)',{timeout:180_000},async(t)=>{
 assert.equal(process.env.GHOST_WALLET_TEST,'fresh-local-only');assert.match(realpathSync(process.cwd()).split('/').at(-1),/^ghost-wallet-local\.[a-zA-Z0-9]+$/);
 const ctx=localContext(process.env.ANCHOR_PROVIDER_URL,id),c=new Connection(ctx.rpcUrl,'confirmed');
 const client=await localWalletClient({rpcUrl:ctx.rpcUrl,programId:ctx.pid,executableBytes:readFileSync(new URL('../target/deploy/ghost_markets.so',import.meta.url))});
 const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../target/localnet-wallet.json',import.meta.url),'utf8'))));
 const creator=Keypair.generate(),trader=Keypair.generate(),treasury=Keypair.generate(),pauser=Keypair.generate();
 const k=marketKeys(ctx,creator.publicKey,0n);
 assert.equal(await c.getAccountInfo(k.protocol),null,'Fresh ledger required');
 async function fund(w){const sig=await c.requestAirdrop(w.publicKey,10_000_000_000);assert.equal((await c.confirmTransaction(sig,'confirmed')).value.err,null);}
 for(const w of [creator,trader,treasury,pauser])await fund(w);
 // Bootstrap uses only the disposable test authority and treasury. The wallet client has no admin action API.
 async function sendBootstrap(ix,signer,extra=[]){await client.guard();const bh=await c.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:signer.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ix);tx.sign(signer,...extra);const sig=await c.sendRawTransaction(tx.serialize());assert.equal((await c.confirmTransaction({...bh,signature:sig},'confirmed')).value.err,null);}
 await sendBootstrap(initialize(ctx,admin.publicKey,pauser.publicKey,treasury.publicKey),admin,[treasury]);await sendBootstrap(setMode(ctx,admin.publicKey,1),admin);
 const callback=w=>async wire=>{const tx=Transaction.from(wire);tx.partialSign(w);return Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));};
 async function signed(d,w){return signPrepared(d,w.publicKey,callback(w));}
 async function submit(d){await client.guard();assert.ok(d.tx.verifySignatures(true));const signature=await c.sendRawTransaction(d.tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed'});assert.equal((await c.confirmTransaction({blockhash:d.blockhash,lastValidBlockHeight:d.lastValidBlockHeight,signature},'confirmed')).value.err,null);return signature;}
 await t.test('creator and admin independent signatures, no unrelated signer',async()=>{
   const d=await client.launch({creator:creator.publicKey,nonce:0n,name:'GHOST WALLET TEST',symbol:'GHOST',feeBps:300n});assert.equal(d.summary.approver,admin.publicKey.toBase58());assert.equal(d.summary.treasury,treasury.publicKey.toBase58());
   await assert.rejects(()=>signed(d,trader));
   const creatorSigned=await signed(d,creator);assert.equal(creatorSigned.tx.verifySignatures(true),false);
   const approved=await signed(creatorSigned,admin);assert.ok(approved.tx.verifySignatures(true));const signature=await submit(approved);
   assert.equal((await getMint(c,k.baseMint)).mintAuthority,null);assert.equal((await client.readMarket(k.market)).s.feeBps,300n);console.log(JSON.stringify({network:'local-validator',market:k.market.toBase58(),mint:k.baseMint.toBase58(),launchSignature:signature}));
   await assert.rejects(()=>client.launch({creator:creator.publicKey,nonce:0n,name:'GHOST',symbol:'GHOST',feeBps:300n}),/already exists/);
 });
 const tokenAta=getAssociatedTokenAddressSync(k.baseMint,trader.publicKey),quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,trader.publicKey);
 async function trade(action,amount,w=trader){const r=await client.readMarket(k.market);const d=await client.trade({wallet:w.publicKey,market:k.market,action,amount,version:String(r.s.version)});await submit(await signed(d,w));return d.summary;}
 await t.test('native SOL wrapping and wallet-owned token outputs, stale quote rejected',async()=>{
   const buy=await trade('buy','0.05');assert.equal((await getAccount(c,tokenAta)).amount,BigInt(buy.minimumOut));assert.equal((await getAccount(c,quoteAta)).amount,0n);
   await assert.rejects(()=>client.trade({wallet:trader.publicKey,market:k.market,action:'buy',amount:'0.01',version:'0'}),/version/);
   const sell=await trade('sell','1');assert.equal((await getAccount(c,quoteAta)).amount,BigInt(sell.minimumOut));
 });
 await t.test('graduation and paused exit use same wallet signing boundary',async()=>{
   const r=await client.readMarket(k.market);await trade('buy',fmt(grossForNet(PROFILE.graduationQuote-r.s.quote,r.s.feeBps),9));
   const d=await client.graduation({wallet:trader.publicKey,market:k.market});await submit(await signed(d,trader));assert.equal((await client.readMarket(k.market)).s.phase,2);
   await sendBootstrap(setMode(ctx,pauser.publicKey,2),pauser);await assert.rejects(async()=>trade('buy','0.001'),/blocked/);await trade('sell','1');
 });
 await t.test('fee beneficiaries sign independently; administrator cannot redirect claims',async()=>{
   const r=await client.readMarket(k.market);await assert.rejects(()=>client.claim({wallet:admin.publicKey,market:k.market}),/beneficiary/);
   for(const [w,owed] of [[creator,r.fees.creator],[treasury,r.fees.platform]]){const dest=getAssociatedTokenAddressSync(NATIVE_MINT,w.publicKey);const d=await client.claim({wallet:w.publicKey,market:k.market});assert.equal(d.summary.destination,dest.toBase58());await submit(await signed(d,w));assert.equal((await getAccount(c,dest)).amount,owed);}
   const after=await client.readMarket(k.market);assert.deepEqual(after.fees,{creator:0n,platform:0n});assert.equal(after.lpLocked,after.lpSupply);
 });
});
