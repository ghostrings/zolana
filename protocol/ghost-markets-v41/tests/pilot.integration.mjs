/** Actual V41 native fee-policy and soft-pause conformance. Loopback only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Connection,Keypair,Transaction,SystemProgram,ComputeBudgetProgram,TransactionInstruction} from '@solana/web3.js';
import {createAccount,createMint,getMint,getAccount,createSyncNativeInstruction,NATIVE_MINT} from '@solana/spl-token';
import {PROFILE,assertMetadata,assertQuoteCap} from '../reference/pilot-profile.mjs';
import {localContext,marketKeys,initialize,setMode,create,swapIx,graduateIx,liquidityIx,claimFeesIx} from '../reference/pilot-instructions.mjs';
import {createNativeMarket,nativeSwap,grossForNet,accrueFees,readFeeLedger,FEE_TIERS} from '../reference/native-fees.mjs';
import {graduate,READY,POOL} from '../reference/lifecycle.mjs';
const OVERSHOOT=6021,AUTH=6016,LOCKED=6014,PAUSED=6015,QUOTE=6002,PROFILE_ERROR=6018,CAP=6019,LP_LOCKED=6020;
const publicGenesis=new Set(['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','EtWTRABZaYq6iMfeYKouRu166VU2xqa1','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);
test('V41 native WSOL fees, independent treasury, locked liquidity, claims and full exits',{timeout:300_000},async t=>{
 assert.equal(process.env.GHOST_MARKETS_TEST_MODE,'public-v41');
 const toml=readFileSync(new URL('../Anchor.toml',import.meta.url),'utf8');
 const id=toml.match(/^ghost_markets\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"\s*$/m)?.[1];assert.ok(id);
 const ctx=localContext(process.env.ANCHOR_PROVIDER_URL,id),c=new Connection(ctx.rpcUrl,'confirmed');
 assert.ok(!publicGenesis.has(await c.getGenesisHash()),'Never use a public cluster');
 const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../target/localnet-wallet.json',import.meta.url),'utf8'))));
 const creator=Keypair.generate(),trader=Keypair.generate(),pauser=Keypair.generate(),treasury=Keypair.generate();
 assert.ok((await c.getAccountInfo(ctx.pid))?.executable);assert.equal((await getMint(c,NATIVE_MINT)).decimals,9);
 for(const signer of [creator,trader,pauser,treasury]){const sig=await c.requestAirdrop(signer.publicKey,100_000_000_000);assert.equal((await c.confirmTransaction(sig,'confirmed')).value.err,null);}
 const name=process.env.GHOST_PILOT_NAME||'GHOST LOCAL PILOT',symbol=process.env.GHOST_PILOT_SYMBOL||'GHOST';assertMetadata(name,symbol);
 let sequence=0;
 async function send(instructions,signer=admin,expected=null,additional=[]){
  const bh=await c.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:signer.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:++sequence}),...([instructions].flat()));
  tx.sign(signer,...additional);const signature=await c.sendRawTransaction(tx.serialize(),{skipPreflight:expected!==null,preflightCommitment:'confirmed'});const r=await c.confirmTransaction({...bh,signature},'confirmed');
  if(expected===true)assert.ok(r.value.err);else if(expected!==null)assert.equal(r.value.err?.InstructionError?.[1]?.Custom,expected,JSON.stringify(r.value.err));else assert.equal(r.value.err,null);return signature;
 }
 const deadline=async()=>BigInt(await c.getSlot('confirmed'))+1000n;
 const k0=marketKeys(ctx,creator.publicKey,0n),make0=()=>create(ctx,creator.publicKey,0n,name,symbol);
 await t.test('bootstrap; reject locked issuance and invalid extra signer/profile',async()=>{
  await send(make0(),creator,true);assert.equal(await c.getAccountInfo(k0.market),null);
  await send(initialize(ctx,trader.publicKey,pauser.publicKey,treasury.publicKey),trader,AUTH,[treasury]);assert.equal(await c.getAccountInfo(k0.protocol),null);
  await send(initialize(ctx,admin.publicKey,pauser.publicKey,admin.publicKey),admin,AUTH);
  await send(initialize(ctx,admin.publicKey,pauser.publicKey,pauser.publicKey),admin,AUTH,[pauser]);
  await send(initialize(ctx,admin.publicKey,pauser.publicKey,treasury.publicKey),admin,null,[treasury]);
  const cfg=await c.getAccountInfo(k0.protocol);assert.equal(cfg.data.length,139);assert.equal(cfg.data[8],2);assert.ok(cfg.data.subarray(107,139).equals(treasury.publicKey.toBuffer()));
  // Treasury cannot be assigned launch/pause roles and does not control market activation.
  function roleIx(name,signer,next){return new TransactionInstruction({programId:ctx.pid,keys:[{pubkey:signer,isSigner:true,isWritable:false},{pubkey:k0.protocol,isSigner:false,isWritable:true}],data:Buffer.concat([createHash('sha256').update(`global:${name}`).digest().subarray(0,8),next.toBuffer()])});}
  await send(roleIx('nominate_admin',admin.publicKey,treasury.publicKey),admin,AUTH);
  await send(roleIx('set_pauser',admin.publicKey,treasury.publicKey),admin,AUTH);
  await send(roleIx('nominate_admin',treasury.publicKey,trader.publicKey),treasury,AUTH);
  assert.deepEqual((await c.getAccountInfo(k0.protocol)).data,cfg.data);
  await send(make0(),creator,LOCKED);
  await send(setMode(ctx,trader.publicKey,1),trader,AUTH);await send(setMode(ctx,treasury.publicKey,1),treasury,AUTH);await send(setMode(ctx,admin.publicKey,1));
  await send(create(ctx,creator.publicKey,0n,name,symbol,{approver:trader.publicKey}),creator,AUTH,[trader]);
  const fake=await createMint(c,admin,admin.publicKey,null,9);await send(create(ctx,creator.publicKey,0n,name,symbol,{quoteMint:fake}),creator,QUOTE);
  await send(create(ctx,creator.publicKey,0n,name,symbol,{supply:PROFILE.supply+1n}),creator,PROFILE_ERROR);
  await send(create(ctx,creator.publicKey,0n,name,symbol,{virtualQuote:100_000_000n,graduationQuote:200_000_000n}),creator,PROFILE_ERROR);
  assert.equal(await c.getAccountInfo(k0.market),null);
 });
 for(const [index,feeBps] of FEE_TIERS.entries())await t.test(`${feeBps/100n}% tier: actual buy/sell, graduation, fee claims and locked LP`,async()=>{
  const nonce=BigInt(index),k=marketKeys(ctx,creator.publicKey,nonce);
  const launchSignature=await send(create(ctx,creator.publicKey,nonce,name,symbol,{feeBps}),creator);
  const mint=await getMint(c,k.baseMint);assert.equal(mint.supply,PROFILE.supply);assert.equal(mint.mintAuthority,null);assert.equal(mint.freezeAuthority,null);
  const account=await c.getAccountInfo(k.market);assert.ok(account?.owner.equals(ctx.pid));assert.equal(account.data[8],2);assert.equal(account.data.readUInt16LE(283),Number(feeBps));assert.ok(account.data.subarray(309,341).equals(treasury.publicKey.toBuffer()));
  const newAccount=(mint,owner)=>createAccount(c,admin,mint,owner,Keypair.generate());
  const userBase=await newAccount(k.baseMint,trader.publicKey),userQuote=await newAccount(NATIVE_MINT,trader.publicKey),userLp=await newAccount(k.lpMint,trader.publicKey);
  const platformQuote=await newAccount(NATIVE_MINT,treasury.publicKey),creatorQuote=await newAccount(NATIVE_MINT,creator.publicKey),adminQuote=await newAccount(NATIVE_MINT,admin.publicKey);
  await send([SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:userQuote,lamports:30_000_000_000}),createSyncNativeInstruction(userQuote)],trader);
  let s=createNativeMarket({...PROFILE,feeBps}),owed={platform:0n,creator:0n};
  const balances=()=>Promise.all([k.baseVault,k.quoteVault,userBase,userQuote,userLp,k.lpLock,platformQuote,creatorQuote].map(async a=>(await getAccount(c,a)).amount));
  async function check(){const b=await balances(),d=(await c.getAccountInfo(k.market)).data;assert.deepEqual(readFeeLedger(d),owed);assert.equal(d.readBigUInt64LE(243),s.version);assert.equal(d.readBigUInt64LE(251),s.base);assert.equal(d.readBigUInt64LE(259),s.quote);assert.equal(b[0],s.base);assert.equal(b[1],s.quote+owed.platform+owed.creator);assertQuoteCap(s,owed.platform+owed.creator);return b;}
  async function order(buy,amount,expected=null){const q=nativeSwap(s,buy,amount),before=await check();await send(swapIx(ctx,k,trader.publicKey,userBase,userQuote,{buy,amountIn:amount,minimumOut:q.amountOut,version:s.version,deadline:await deadline()}),trader,expected);if(expected!==null){assert.deepEqual(await check(),before);return;}s=q.next;owed=accrueFees(owed,q);const after=await check();if(buy){assert.equal(before[3]-after[3],amount);assert.equal(after[2]-before[2],q.amountOut);}else{assert.equal(before[2]-after[2],amount);assert.equal(after[3]-before[3],q.amountOut);}}
  await order(true,PROFILE.quoteCap+1n,OVERSHOOT);
  // Exact round trip before graduation: all circulating base returned, real quote reserve reaches zero.
  const exactGross=grossForNet(25_000_000n,feeBps);await order(true,exactGross);
  assert.equal(s.quote,25_000_000n);await send(setMode(ctx,pauser.publicKey,2),pauser);
  await order(false,PROFILE.supply-s.base);assert.ok(s.quote<=1n,`Unexpected rounding residue ${s.quote}`);assert.equal(s.base,PROFILE.supply);
  await send(setMode(ctx,admin.publicKey,1));await order(true,50_000_000n);
  await send(setMode(ctx,pauser.publicKey,2),pauser);await order(true,1_000_000n,PAUSED);await order(false,10_000_000_000n);await send(setMode(ctx,pauser.publicKey,1),pauser,AUTH);await send(setMode(ctx,admin.publicKey,1));
  // Claims must neither redirect a beneficiary's fees nor consume reserves.
  const beforeBad=await check();await send(claimFeesIx(ctx,k,trader.publicKey,userQuote),trader,AUTH);await send(claimFeesIx(ctx,k,creator.publicKey,platformQuote),creator,true);assert.deepEqual(await check(),beforeBad);
  const needed=PROFILE.graduationQuote-s.quote;await order(true,grossForNet(needed,feeBps));assert.equal(s.phase,READY);
  await send(setMode(ctx,pauser.publicKey,2),pauser);
  // READY can graduate without admin intervention even under the soft pause.
  const g=graduate(s);await send(graduateIx(ctx,k,s.version,await deadline()),trader);s=g.next;assert.equal(s.phase,POOL);await check();assert.equal((await getMint(c,k.lpMint)).supply,g.lockedLp);assert.equal((await getAccount(c,k.lpLock)).amount,g.lockedLp);assert.equal((await getMint(c,k.baseMint)).supply,PROFILE.supply-g.baseToBurn);
  await send(setMode(ctx,admin.publicKey,1));await order(true,PROFILE.quoteCap+1n,CAP);await send(setMode(ctx,pauser.publicKey,2),pauser);
  const creatorAtGraduation=owed.creator;await order(true,10_000_000n,PAUSED);await order(false,1_000_000_000n);assert.equal(owed.creator,creatorAtGraduation);await send(setMode(ctx,admin.publicKey,1));await order(true,10_000_000n);await order(false,1_000_000_000n);assert.equal(owed.creator,creatorAtGraduation);
  const beforeLp=await check();for(const add of [true,false])await send(liquidityIx(ctx,k,trader.publicKey,userBase,userQuote,userLp,add,[1n,1n,1n],s.version,await deadline()),trader,LP_LOCKED);assert.deepEqual(await check(),beforeLp);
  await send(setMode(ctx,pauser.publicKey,2),pauser);await order(true,1_000_000n,PAUSED);await order(false,1_000_000_000n);assert.equal(owed.creator,creatorAtGraduation);
  const beforeClaim=await check(),expectedPlatform=owed.platform,expectedCreator=owed.creator;
  await send(claimFeesIx(ctx,k,admin.publicKey,adminQuote),admin,AUTH);assert.deepEqual(await check(),beforeClaim);
   await send(claimFeesIx(ctx,k,treasury.publicKey,platformQuote),treasury);owed={...owed,platform:0n};await check();
  await send(claimFeesIx(ctx,k,creator.publicKey,creatorQuote),creator);owed={...owed,creator:0n};const after=await check();
  assert.equal(after[6]-beforeClaim[6],expectedPlatform);assert.equal(after[7]-beforeClaim[7],expectedCreator);assert.equal(after[1],s.quote);assert.equal(after[5],g.lockedLp);assert.equal(after[4],0n);
  await send(claimFeesIx(ctx,k,creator.publicKey,creatorQuote),creator,6007);assert.deepEqual(await check(),after);
  await send(setMode(ctx,admin.publicKey,1));
  console.log(JSON.stringify({network:'loopback-local-validator',feeBps:Number(feeBps),mint:k.baseMint.toBase58(),market:k.market.toBase58(),launchSignature,platformFeesClaimed:expectedPlatform.toString(),deployerFeesClaimed:expectedCreator.toString(),lockedLp:g.lockedLp.toString(),privateSettlement:false}));
 });
 await t.test('any wallet may create: treasury as creator, two fee ledgers claimed without redirection',async()=>{
  const nonce=0n,k=marketKeys(ctx,treasury.publicKey,nonce);
  await send(create(ctx,treasury.publicKey,nonce,'TREASURY FIXTURE','TREAS'),treasury);
  const traderBase=await createAccount(c,admin,k.baseMint,trader.publicKey,Keypair.generate());
  const traderQuote=await createAccount(c,admin,NATIVE_MINT,trader.publicKey,Keypair.generate());
  const recipientQuote=await createAccount(c,admin,NATIVE_MINT,treasury.publicKey,Keypair.generate());
  await send([SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:traderQuote,lamports:100_000_000}),createSyncNativeInstruction(traderQuote)],trader);
  const amount=10_000_000n,s=createNativeMarket(PROFILE),q=nativeSwap(s,true,amount);
  await send(swapIx(ctx,k,trader.publicKey,traderBase,traderQuote,{buy:true,amountIn:amount,minimumOut:q.amountOut,version:0n,deadline:await deadline()}),trader);
  const before=readFeeLedger((await c.getAccountInfo(k.market)).data);
  assert.ok(before.platform>0n&&before.creator>0n);
  const bal=(await getAccount(c,recipientQuote)).amount;
  await send(claimFeesIx(ctx,k,treasury.publicKey,recipientQuote),treasury);
  assert.equal((await getAccount(c,recipientQuote)).amount-bal,before.platform+before.creator);
  assert.deepEqual(readFeeLedger((await c.getAccountInfo(k.market)).data),{platform:0n,creator:0n});
 });
 await send(setMode(ctx,pauser.publicKey,2),pauser);
});
