/** Preserve V33 market and config bytes across a same-address LOOPBACK upgrade. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {Connection,PublicKey,Keypair,SystemProgram,Transaction,ComputeBudgetProgram} from '@solana/web3.js';
import {createAccount,getAccount,getMint,createSyncNativeInstruction,NATIVE_MINT} from '@solana/spl-token';
import * as v33 from '../reference/pilot-instructions.mjs';
import * as v41 from '../../new/reference/pilot-instructions.mjs';
import {PROFILE as oldProfile} from '../reference/pilot-profile.mjs';
import {PROFILE as newProfile} from '../../new/reference/pilot-profile.mjs';
import {createNativeMarket,nativeSwap,grossForNet,readFeeLedger} from '../reference/native-fees.mjs';
import {graduate} from '../reference/lifecycle.mjs';
const publicGenesis=new Set(['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','EtWTRABZaYq6iMfeYKouRu166VU2xqa1','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);
const load=p=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p,'utf8'))));
test('V33 funded curve and graduated pool survive a local V41 upgrade',{timeout:300000},async()=>{
 assert.equal(process.env.GHOST_V41_COMPAT,'local-only');
 const root=realpathSync(process.cwd()),path=resolve(root,'target/localnet-wallet.json'),pid=load(resolve(root,'target/deploy/ghost_markets-keypair.json')).publicKey;
 const c0=v33.localContext(process.env.ANCHOR_PROVIDER_URL,pid),c=new Connection(c0.rpcUrl,'confirmed');
 const gen=await c.getGenesisHash();assert.ok(!publicGenesis.has(gen));assert.ok((await c.getAccountInfo(pid))?.executable);
 const admin=load(path),creator=Keypair.generate(),trader=Keypair.generate(),treasury=Keypair.generate(),pauser=Keypair.generate();
 const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),pd=PublicKey.findProgramAddressSync([pid.toBuffer()],loader)[0];
 const programData=await c.getAccountInfo(pd);assert.ok(programData.owner.equals(loader));assert.equal(programData.data[12],1);assert.ok(new PublicKey(programData.data.subarray(13,45)).equals(admin.publicKey));
 for(const k of [creator,trader,treasury,pauser]){const sig=await c.requestAirdrop(k.publicKey,10_000_000_000);assert.equal((await c.confirmTransaction(sig,'confirmed')).value.err,null);}
 let seq=0;async function send(ix,who=admin,extra=[],fail=false){const bh=await c.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:who.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:++seq}),...([ix].flat()));tx.sign(who,...extra);const sig=await c.sendRawTransaction(tx.serialize(),{skipPreflight:fail});const r=await c.confirmTransaction({...bh,signature:sig},'confirmed');if(fail)assert.ok(r.value.err);else assert.equal(r.value.err,null);}
 const deadline=async()=>BigInt(await c.getSlot('confirmed'))+1000n;
 await send(v33.initialize(c0,admin.publicKey,pauser.publicKey,treasury.publicKey),admin,[treasury]);await send(v33.setMode(c0,admin.publicKey,1));
 const cases=[];
 for(let i=0;i<2;i++){
  const k=v33.marketKeys(c0,creator.publicKey,BigInt(i));
  await send(v33.create(c0,creator.publicKey,BigInt(i),'V33 FIXTURE','OLD',{approver:admin.publicKey}),creator,[admin]);
  const base=await createAccount(c,admin,k.baseMint,trader.publicKey,Keypair.generate()),quote=await createAccount(c,admin,NATIVE_MINT,trader.publicKey,Keypair.generate());
  await send([SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:quote,lamports:2_000_000_000}),createSyncNativeInstruction(quote)],trader);
  let s=createNativeMarket(oldProfile);const amount=i===0?10_000_000n:grossForNet(oldProfile.graduationQuote,oldProfile.feeBps),q=nativeSwap(s,true,amount);
  await send(v33.swapIx(c0,k,trader.publicKey,base,quote,{buy:true,amountIn:amount,minimumOut:q.amountOut,version:s.version,deadline:await deadline()}),trader);s=q.next;
  if(i===1){await send(v33.graduateIx(c0,k,s.version,await deadline()),trader);s=graduate(s).next;}
  cases.push({k,base,quote,s});
 }
 const addresses=[cases[0].k.protocol,...cases.flatMap(x=>[x.k.market,x.k.baseMint,x.k.lpMint,x.k.baseVault,x.k.quoteVault,x.k.lpLock,x.base,x.quote])];
 const snapshot=async()=> (await c.getMultipleAccountsInfo(addresses,'confirmed')).map(a=>{assert.ok(a);return [a.owner.toBase58(),a.lamports,a.data.toString('base64')];});
 const before=await snapshot();
 // Explicit local RPC and locally generated authority/key only. Never use default Solana config for a write.
 const binary=realpathSync(resolve(root,'../new/target/deploy/ghost_markets.so'));assert.ok(binary.startsWith(resolve(root,'../new')+'/'));
 execFileSync('solana',['--url',c0.rpcUrl,'--keypair',path,'program','deploy',binary,'--program-id',resolve(root,'target/deploy/ghost_markets-keypair.json'),'--upgrade-authority',path],{stdio:'inherit',timeout:180000});
 assert.equal(await c.getGenesisHash(),gen);assert.deepEqual(await snapshot(),before,'Upgrade must not mutate existing market/config/vault bytes');
 const deployed=(await c.getAccountInfo(pd)).data.subarray(45),candidate=readFileSync(binary);assert.ok(deployed.subarray(0,candidate.length).equals(candidate)&&deployed.subarray(candidate.length).every(x=>x===0),'Wrong upgraded bytes');
 const c1=v41.localContext(c0.rpcUrl,pid);
 // Ensure the upgrade has become effective in a later slot before exercising it.
 const end=Date.now()+20000,slot=Number((await c.getAccountInfo(pd)).data.readBigUInt64LE(4));while(await c.getSlot('confirmed')<=slot){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,250));}
 for(const {k,base,quote,s} of cases){
  const oldBytes=(await c.getAccountInfo(k.market)).data,fees=readFeeLedger(oldBytes),amt=1_010_000_000n;
  await send(v41.swapIx(c1,k,trader.publicKey,base,quote,{buy:true,amountIn:amt,minimumOut:1n,version:s.version,deadline:await deadline()}),trader,[],true);
  assert.ok((await c.getAccountInfo(k.market)).data.equals(oldBytes));
  const sell=1_000_000n,q=nativeSwap(s,false,sell);await send(v41.swapIx(c1,k,trader.publicKey,base,quote,{buy:false,amountIn:sell,minimumOut:q.amountOut,version:s.version,deadline:await deadline()}),trader);
  const d=(await c.getAccountInfo(k.market)).data;assert.equal(d.readBigUInt64LE(267),oldProfile.virtualQuote);assert.equal(d.readBigUInt64LE(275),oldProfile.graduationQuote);assert.equal(d.readBigUInt64LE(259),q.next.quote);assert.equal(readFeeLedger(d).platform,fees.platform+q.platform);assert.equal(readFeeLedger(d).creator,fees.creator+q.creator);
  assert.equal((await getAccount(c,k.quoteVault)).amount,q.next.quote+fees.platform+q.platform+fees.creator+q.creator);
 }
 // New V41 profile is created by a third party without an administrator signature.
 const k=v41.marketKeys(c1,trader.publicKey,99n);await send(v41.create(c1,trader.publicKey,99n,'V41 FIXTURE','NEW'),trader);
 const d=(await c.getAccountInfo(k.market)).data;assert.equal(d.readBigUInt64LE(267),newProfile.virtualQuote);assert.equal(d.readBigUInt64LE(275),newProfile.graduationQuote);assert.equal((await getMint(c,k.baseMint)).supply,newProfile.supply);
 console.log('LOOPBACK only: V33 curve + pool account bytes, reserve caps and sell math preserved; one-signer V41 mint created');
});
