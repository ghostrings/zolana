/** Actual transaction conformance test. Run ONLY via scripts/test-localnet.sh. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createMint, mintTo, getMint, getAccount, createAccount, transfer, burn } from '@solana/spl-token';
import { createMarket, swap, graduate, addLiquidity, removeLiquidity, CURVE, READY, POOL } from '../reference/lifecycle.mjs';

function tag(name) { return createHash('sha256').update(`global:${name}`).digest().subarray(0,8); }
function u64(x) { const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(x));return b; }
function u16(x) { const b=Buffer.alloc(2);b.writeUInt16LE(Number(x));return b; }
function str(s) { const body=Buffer.from(s,'utf8'),b=Buffer.alloc(4);b.writeUInt32LE(body.length);return Buffer.concat([b,body]); }
function meta(pubkey,isWritable=false,isSigner=false) { return {pubkey,isWritable,isSigner}; }
function ix(pid,name,keys,...parts) { return new TransactionInstruction({programId:pid,keys,data:Buffer.concat([tag(name),...parts])}); }
const pda=(pid,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(x=>typeof x==='string'?Buffer.from(x):x),pid)[0];

function requireLoopback() {
  const raw=process.env.ANCHOR_PROVIDER_URL;
  if(!raw) throw new Error('Missing local validator URL. Run scripts/test-localnet.sh.');
  const url=new URL(raw);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Refusing a non-loopback validator.');
  return url.href;
}
function declaredProgram() {
  const toml=readFileSync(new URL('../Anchor.toml',import.meta.url),'utf8');
  const found=toml.match(/^ghost_markets\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"\s*$/m);
  if(!found) throw new Error('Program ID not found');
  return new PublicKey(found[1]);
}
function decodeMarket(bytes) {
  const d=Buffer.from(bytes);const discriminator=createHash('sha256').update('account:Market').digest().subarray(0,8);
  assert.ok(d.subarray(0,8).equals(discriminator));assert.equal(d[8],1);
  const offset=8+3+32+8+6*32;
  return {phase:d[10],version:d.readBigUInt64LE(offset),base:d.readBigUInt64LE(offset+8),quote:d.readBigUInt64LE(offset+16),virtualQuote:d.readBigUInt64LE(offset+24),graduationQuote:d.readBigUInt64LE(offset+32),feeBps:BigInt(d.readUInt16LE(offset+40)),initialSupply:d.readBigUInt64LE(offset+42),burned:d.readBigUInt64LE(offset+50),locked:d.readBigUInt64LE(offset+58)};
}

test('actual local validator lifecycle, authority, substitution and atomic rollback',{timeout:180_000},async(t)=>{
 const c=new Connection(requireLoopback(),'confirmed'),pid=declaredProgram();
 const deployed=await c.getAccountInfo(pid,'confirmed');assert.ok(deployed?.executable,'Expected a local executable GHOST Markets program');
 const payer=Keypair.generate(),other=Keypair.generate(),nonce=7n; // ephemeral local-only keys, never read a user wallet
 for(const k of [payer,other]){const airdrop=await c.requestAirdrop(k.publicKey,10_000_000_000);await c.confirmTransaction(airdrop,'confirmed');}
 const quoteMint=await createMint(c,payer,payer.publicKey,null,6);
 const market=pda(pid,'market',payer.publicKey.toBuffer(),u64(nonce));
 const baseMint=pda(pid,'base-mint',market.toBuffer()),lpMint=pda(pid,'lp-mint',market.toBuffer());
 const baseVault=pda(pid,'base-vault',market.toBuffer()),quoteVault=pda(pid,'quote-vault',market.toBuffer()),lpLock=pda(pid,'lp-lock',market.toBuffer());
 const supply=1_000_000n,virtualQuote=100_000n,graduationQuote=200_000n,feeBps=30n;
 let s=createMarket({supply,virtualQuote,graduationQuote,feeBps});
 let sequence=0;
 async function send(instruction,signer=payer,expectFailure=false){
  const bh=await c.getLatestBlockhash('confirmed');
  const tx=new Transaction({feePayer:signer.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:++sequence}),instruction);
  tx.sign(signer);
  // Negative cases are submitted to the local validator, not merely simulated by preflight.
  const signature=await c.sendRawTransaction(tx.serialize(),{skipPreflight:expectFailure,preflightCommitment:'confirmed'});
  const result=await c.confirmTransaction({...bh,signature},'confirmed');
  if(expectFailure) assert.ok(result.value.err,'expected a confirmed failed transaction');else assert.equal(result.value.err,null);
  return signature;
 }
 const deadline=async()=>BigInt(await c.getSlot('confirmed'))+1000n;
 const createKeys=[meta(payer.publicKey,true,true),meta(market,true),meta(baseMint,true),meta(quoteMint),meta(lpMint,true),meta(baseVault,true),meta(quoteVault,true),meta(lpLock,true),meta(TOKEN_PROGRAM_ID),meta(SystemProgram.programId),meta(SYSVAR_RENT_PUBKEY)];
 const createIx=ix(pid,'create_market',createKeys,u64(nonce),str('GHOST LOCAL TEST'),str('GHOST'),str(''),u64(supply),u64(virtualQuote),u64(graduationQuote),u16(feeBps));
 await send(createIx);
 const userBase=await createAccount(c,payer,baseMint,payer.publicKey),userQuote=await createAccount(c,payer,quoteMint,payer.publicKey),userLp=await createAccount(c,payer,lpMint,payer.publicKey),emptyQuote=await createAccount(c,payer,quoteMint,payer.publicKey);
 await mintTo(c,payer,quoteMint,userQuote,payer,5_000_000n);
 async function snapshot(){
  const [m,bv,qv,b,q,lp,lm,bm,lock,empty]=await Promise.all([c.getAccountInfo(market,'confirmed'),getAccount(c,baseVault),getAccount(c,quoteVault),getAccount(c,userBase),getAccount(c,userQuote),getAccount(c,userLp),getMint(c,lpMint),getMint(c,baseMint),getAccount(c,lpLock),getAccount(c,emptyQuote)]);
  assert.ok(m?.owner.equals(pid));assert.ok(bv.owner.equals(market)&&qv.owner.equals(market)&&lock.owner.equals(market));
  return {m:decodeMarket(m.data),bv:bv.amount,qv:qv.amount,userBase:b.amount,userQuote:q.amount,userLp:lp.amount,lpSupply:lm.supply,baseSupply:bm.supply,lock:lock.amount,empty:empty.amount};
 }
 let quoteSurplus=0n;
 async function checkState(){const x=await snapshot();for(const key of Object.keys(s)) assert.equal(x.m[key],s[key],key);assert.equal(x.bv,s.base);assert.equal(x.qv,s.quote+quoteSurplus);return x;}
 async function rejected(instruction){const before=await snapshot();await send(instruction,payer,true);assert.deepEqual(await snapshot(),before,'failed instruction must not change market or token balances');}
 function swapIx(buy,amount,minimum,version,end,changes={}){
  return ix(pid,'swap',[meta(payer.publicKey,false,true),meta(market,true),meta(baseMint),meta(quoteMint),meta(changes.baseVault??baseVault,true),meta(changes.quoteVault??quoteVault,true),meta(changes.userBase??userBase,true),meta(changes.userQuote??userQuote,true),meta(TOKEN_PROGRAM_ID)],Buffer.from([buy?1:0]),u64(amount),u64(minimum),u64(version),u64(end));
 }
 const gradIx=(version,end)=>ix(pid,'graduate',[meta(market,true),meta(baseMint,true),meta(quoteMint),meta(lpMint,true),meta(baseVault,true),meta(quoteVault),meta(lpLock,true),meta(TOKEN_PROGRAM_ID)],u64(version),u64(end));
 function lpIx(add,args,version,end,quoteAccount=userQuote){return ix(pid,add?'add_liquidity':'remove_liquidity',[meta(payer.publicKey,false,true),meta(market,true),meta(baseMint),meta(quoteMint),meta(lpMint,true),meta(baseVault,true),meta(quoteVault,true),meta(lpLock),meta(userBase,true),meta(quoteAccount,true),meta(userLp,true),meta(TOKEN_PROGRAM_ID)],...args.map(u64),u64(version),u64(end));}
 await t.test('fixed issuance and early graduation rejection',async()=>{
  const m=await getMint(c,baseMint);assert.equal(m.mintAuthority,null);assert.equal(m.freezeAuthority,null);assert.equal(m.supply,supply);
  const x=await checkState();assert.equal(x.userBase,0n);assert.equal(x.bv,supply);assert.equal(x.qv,0n);assert.equal(x.lpSupply,0n);assert.equal(s.phase,CURVE);
  await rejected(gradIx(s.version,await deadline()));await rejected(createIx);
  const before=await snapshot();await assert.rejects(()=>mintTo(c,payer,baseMint,userBase,payer,1n));await assert.rejects(()=>transfer(c,payer,baseVault,userBase,payer,1n));assert.deepEqual(await snapshot(),before);
 });
 await t.test('curve buy and sell, stale version, deadline, account substitution, slippage',async()=>{
  let before=await checkState(),q=swap(s,true,50_000n);await send(swapIx(true,50_000n,q.amountOut,s.version,await deadline()));s=q.next;let after=await checkState();assert.equal(after.userBase-before.userBase,q.amountOut);assert.equal(before.userQuote-after.userQuote,50_000n);
  await rejected(swapIx(true,10_000n,1n,s.version-1n,await deadline()));await rejected(swapIx(true,10_000n,1n,s.version,0n));
  await rejected(swapIx(true,10_000n,1n,s.version,await deadline(),{quoteVault:userQuote}));
  await rejected(swapIx(true,10_000n,s.base,s.version,await deadline()));
  // Empty quote input must reject without a state change.
  await rejected(swapIx(true,10_000n,1n,s.version,await deadline(),{userQuote:emptyQuote}));
  before=await checkState();q=swap(s,false,10_000n);await send(swapIx(false,10_000n,q.amountOut,s.version,await deadline()));s=q.next;after=await checkState();assert.equal(before.userBase-after.userBase,10_000n);assert.equal(after.userQuote-before.userQuote,q.amountOut);
 });
 let g;
 await t.test('permissionless graduation and genesis liquidity lock',async()=>{
  const input=graduationQuote-s.quote,q=swap(s,true,input);await send(swapIx(true,input,q.amountOut,s.version,await deadline()));s=q.next;assert.equal(s.phase,READY);await checkState();
  await rejected(swapIx(true,1_000n,1n,s.version,await deadline()));g=graduate(s);await send(gradIx(s.version,await deadline()),other);s=g.next;
  const x=await checkState();assert.equal(s.phase,POOL);assert.equal(x.bv,s.base);assert.equal(x.qv,s.quote);assert.equal(x.baseSupply,supply-g.baseToBurn);assert.equal(x.m.burned,g.baseToBurn);assert.equal(x.m.locked,g.lockedLp);assert.equal(x.lock,g.lockedLp);assert.equal(x.lpSupply,g.lockedLp);await rejected(gradIx(s.version,await deadline()));
 });
 await t.test('pool settlement, donation accounting and failed second CPI rollback',async()=>{
  const q=swap(s,true,10_000n);await send(swapIx(true,10_000n,q.amountOut,s.version,await deadline()));s=q.next;await checkState();
  await transfer(c,payer,userQuote,quoteVault,payer,33n);quoteSurplus+=33n;let x=await checkState();assert.equal(x.qv,s.quote+33n);
  const maxBase=20_000n,maxQuote=20_000n,l=addLiquidity(s,x.lpSupply,maxBase,maxQuote);
  // The base input CPI is valid, the quote input CPI fails for insufficient balance. Verify rollback.
  await rejected(lpIx(true,[maxBase,maxQuote,l.shares],s.version,await deadline(),emptyQuote));
  await send(lpIx(true,[maxBase,maxQuote,l.shares],s.version,await deadline()));s=l.next;x=await checkState();assert.equal(x.userLp,l.shares);assert.equal(x.lpSupply,g.lockedLp+l.shares);assert.equal(x.qv,s.quote+33n);
 });
 await t.test('external LP burns and lock transfers accounted using actual supply',async()=>{
  let x=await checkState();const burned=x.userLp/5n,donated=x.userLp/7n;assert.ok(burned>0n&&donated>0n);
  await burn(c,payer,userLp,lpMint,payer,burned);await transfer(c,payer,userLp,lpLock,payer,donated);x=await checkState();assert.equal(x.lock,g.lockedLp+donated);
  await rejected(lpIx(false,[x.userLp+1n,1n,1n],s.version,await deadline()));
  const l=removeLiquidity(s,x.lpSupply,x.lock,x.userLp);await send(lpIx(false,[l.shares,l.baseAmount,l.quoteAmount],s.version,await deadline()));s=l.next;x=await checkState();assert.equal(x.userLp,0n);assert.equal(x.lpSupply,x.lock);assert.equal(x.qv,s.quote+33n);assert.ok(x.bv>0n&&x.qv>0n);
 });
});
