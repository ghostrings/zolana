/** Standalone loopback lab. Not part of the deployed web server. Never reads production keys. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { createAccount, createSyncNativeInstruction, getAccount, getMint, NATIVE_MINT } from '@solana/spl-token';
import { localContext, marketKeys, initialize, setMode, create, swapIx, graduateIx, claimFeesIx } from '../reference/pilot-instructions.mjs';
import { PROFILE } from '../reference/pilot-profile.mjs';
import {readFeeLedger} from '../reference/native-fees.mjs';
import { marketState, protocolMode, quoteAction, assertLaunch, actionFailure, json, allowedRequest, LOOPBACK_ORIGIN } from './core.mjs';
const LIVE='5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const knownPublicGenesis=new Set(['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','EtWTRABZaYq6iMfeYKouRu166VU2xqa1','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);
if(process.env.GHOST_NATIVE_LAB!=='fresh-local-only')throw new Error('Start via scripts/native-lab.sh');
if(!/^ghost-native-lab\.[a-zA-Z0-9]+$/.test(realpathSync(process.cwd()).split('/').at(-1)))throw new Error('Fresh isolated workspace required');
const config=readFileSync(new URL('../Anchor.toml',import.meta.url),'utf8');
const id=config.match(/^ghost_markets\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"\s*$/m)?.[1];
const ctx=localContext(process.env.ANCHOR_PROVIDER_URL,id),c=new Connection(ctx.rpcUrl,'confirmed');
if(id===LIVE||knownPublicGenesis.has(await c.getGenesisHash()))throw new Error('Public cluster refused');
const genesis=await c.getGenesisHash();
const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../target/localnet-wallet.json',import.meta.url),'utf8'))));
const trader=Keypair.generate(),creator=Keypair.generate(),pauser=Keypair.generate(),treasury=Keypair.generate(),nonce=0n,k=marketKeys(ctx,creator.publicKey,nonce);
const programData=PublicKey.findProgramAddressSync([ctx.pid.toBuffer()],LOADER)[0];
const program=await c.getAccountInfo(ctx.pid),pd=await c.getAccountInfo(programData);
if(!program?.executable||!program.owner.equals(LOADER)||program.data.length!==36||program.data.readUInt32LE(0)!==2||!program.data.subarray(4).equals(programData.toBuffer())||!pd?.owner.equals(LOADER)||pd.data.readUInt32LE(0)!==3||pd.data[12]!==1||!pd.data.subarray(13,45).equals(admin.publicKey.toBuffer()))throw new Error('Expected a fresh upgradeable local program with local authority');
if(await c.getAccountInfo(k.protocol)||await c.getAccountInfo(k.market))throw new Error('Fresh empty local ledger required');
if((await getMint(c,NATIVE_MINT)).decimals!==PROFILE.quoteDecimals)throw new Error('Unexpected local WSOL mint');
let mutationStarted=false;
let seq=0, busy=false, userBase=null,userQuote=null,userLp=null,platformQuote=null,creatorQuote=null,lastSignature=null,launchSignature=null,halted=false;
async function ensureLocal(){if(await c.getGenesisHash()!==genesis||knownPublicGenesis.has(genesis))throw new Error('Local ledger changed; restart lab');}
async function send(instructions,signer=admin,additional=[]){
 await ensureLocal();const bh=await c.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:signer.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:++seq}),...([instructions].flat()));
 tx.sign(signer,...additional);mutationStarted=true;const signature=await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed'});
 const result=await c.confirmTransaction({...bh,signature},'confirmed');if(result.value.err)throw new Error('Local transaction rejected');lastSignature=signature;return signature;
}
const deadline=async()=>BigInt(await c.getSlot('confirmed'))+1000n;
for(const a of [trader,creator,pauser,treasury]){const sig=await c.requestAirdrop(a.publicKey,10_000_000_000);if((await c.confirmTransaction(sig,'confirmed')).value.err)throw new Error('Local funding failed');}
await send(initialize(ctx,admin.publicKey,pauser.publicKey,treasury.publicKey),admin,[treasury]);await send(setMode(ctx,admin.publicKey,1));
async function read(){
 const [config,market]=await c.getMultipleAccountsInfo([k.protocol,k.market],'confirmed');
 if(!config?.owner.equals(ctx.pid)||!config.data.subarray(11,43).equals(admin.publicKey.toBuffer())||!config.data.subarray(43,75).equals(pauser.publicKey.toBuffer())||!config.data.subarray(107,139).equals(treasury.publicKey.toBuffer()))throw new Error('Unexpected protocol authorities');
 const mode=protocolMode(config.data);
 if(!market)return {mode,market:null};
 if(!market.owner.equals(ctx.pid)||!market.data.subarray(11,43).equals(creator.publicKey.toBuffer())||!market.data.subarray(309,341).equals(treasury.publicKey.toBuffer())||market.data.readBigUInt64LE(43)!==nonce)throw new Error('Unexpected market identity');
 for(const [offset,address] of [[51,k.baseMint],[83,k.quoteMint],[115,k.lpMint],[147,k.baseVault],[179,k.quoteVault],[211,k.lpLock]])if(!market.data.subarray(offset,offset+32).equals(address.toBuffer()))throw new Error('Market account mismatch');
 const s=marketState(market.data),fees=readFeeLedger(market.data);
 const [base,quote,lock,mint,bm]=await Promise.all([getAccount(c,k.baseVault),getAccount(c,k.quoteVault),getAccount(c,k.lpLock),getMint(c,k.lpMint),getMint(c,k.baseMint)]);
 if(!base.owner.equals(k.market)||!quote.owner.equals(k.market)||!lock.owner.equals(k.market)||base.amount<s.base||quote.amount<s.quote+fees.platform+fees.creator||bm.mintAuthority!==null||bm.freezeAuthority!==null)throw new Error('Vault or mint mismatch');
 const balances=userBase&&userQuote&&userLp?(await Promise.all([userBase,userQuote,userLp].map(a=>getAccount(c,a)))).map(a=>a.amount):null;
 if(s.phase===2&&(mint.supply!==lock.amount||lock.amount===0n))throw new Error('Native LP lock mismatch');
 const feeBalances=platformQuote&&creatorQuote?(await Promise.all([platformQuote,creatorQuote].map(a=>getAccount(c,a)))).map(a=>a.amount):null;
 let offset=357;const readText=()=>{const n=market.data.readUInt32LE(offset);offset+=4;const t=market.data.subarray(offset,offset+n).toString('utf8');offset+=n;return t;};
 return {mode,market:s,lpSupply:mint.supply,lpLocked:lock.amount,baseSupply:bm.supply,balances,fees,feeBalances,name:readText(),symbol:readText()};
}
async function snapshot(){return {...await read(),programId:id,marketAddress:k.market.toBase58(),mint:k.baseMint.toBase58(),trader:trader.publicKey.toBase58(),creator:creator.publicKey.toBase58(),platform:treasury.publicKey.toBase58(),network:'fresh loopback validator — public test SPL',privateSettlement:false,lastSignature,launchSignature,halted};}
let approval=null;
async function action(body){
 if(halted)throw new Error('Lab stopped after uncertain transaction; restart for a fresh test');
 if(body.action==='launch'){
  if((await read()).market)throw new Error('This lab supports one market per session');
  const {name,symbol,feeBps}=assertLaunch(body);
  launchSignature=await send(create(ctx,creator.publicKey,nonce,name,symbol,{feeBps,approver:admin.publicKey}),creator,[admin]);
  userBase=await createAccount(c,trader,k.baseMint,trader.publicKey,Keypair.generate());
  userQuote=await createAccount(c,trader,NATIVE_MINT,trader.publicKey,Keypair.generate());
  userLp=await createAccount(c,trader,k.lpMint,trader.publicKey,Keypair.generate());
  platformQuote=await createAccount(c,admin,NATIVE_MINT,treasury.publicKey,Keypair.generate());
  creatorQuote=await createAccount(c,admin,NATIVE_MINT,creator.publicKey,Keypair.generate());
  await send([SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:userQuote,lamports:2_000_000_000}),createSyncNativeInstruction(userQuote)],trader);
 }else if(body.action==='claim-platform'||body.action==='claim-creator'){
  const r=await read(),platform=body.action==='claim-platform',recipient=platform?treasury:creator,destination=platform?platformQuote:creatorQuote;
  if(!r.market||!destination||!(platform?r.fees.platform:r.fees.creator))throw new Error('No fees to claim');
  await send(claimFeesIx(ctx,k,recipient.publicKey,destination),recipient);
 }else if(body.action==='pause'||body.action==='resume'){
  await send(setMode(ctx,body.action==='pause'?pauser.publicKey:admin.publicKey,body.action==='pause'?2:1),body.action==='pause'?pauser:admin);
 }else{
  const r=await read();if(!r.market||!r.balances)throw new Error('Create market first');
  const q=quoteAction(r.market,r.lpSupply,r.lpLocked,r.mode,body,r.fees);
  if(!approval||approval.expires<Date.now()||approval.id!==body.approval||approval.binding!==json(q))throw new Error('Request a fresh quote before confirming');
  approval=null;const end=await deadline(),version=r.market.version;
  let instruction;
  if(q.action==='buy'||q.action==='sell')instruction=swapIx(ctx,k,trader.publicKey,userBase,userQuote,{buy:q.action==='buy',amountIn:q.amountIn,minimumOut:q.minimumOut,version,deadline:end});
  else if(q.action==='graduate')instruction=graduateIx(ctx,k,version,end);
  else throw new Error('Native pilot has no external LP operations');
  await send(instruction,trader);
 }
 approval=null;return snapshot();
}
const token=randomBytes(24).toString('hex');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8').replace('LAB_TOKEN_PLACEHOLDER',token);
const js=readFileSync(new URL('./ui.js',import.meta.url));
function respond(res,status,body,contentType='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'Referrer-Policy':'no-referrer'});res.end(body);}
async function bodyOf(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('Request too large');}const v=JSON.parse(body);if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid request');return v;}
const server=createServer(async(req,res)=>{
 if(!allowedRequest(req,token)){respond(res,403,json({error:'Local origin required'}));return;}
 if(req.method==='GET'&&req.url==='/'){respond(res,200,html,'text/html; charset=utf-8');return;}
 if(req.method==='GET'&&req.url==='/ui.js'){respond(res,200,js,'text/javascript; charset=utf-8');return;}
 if(busy){respond(res,409,json({error:'Another local operation is running'}));return;}
 busy=true;mutationStarted=false;let mutation=false;
 try{
  if(req.method==='GET'&&req.url==='/state')respond(res,200,json(await snapshot()));
  else if(req.method==='POST'&&req.url==='/quote'){
   const b=await bodyOf(req),r=await read();if(!r.market||!r.balances)throw new Error('Create market first');const q=quoteAction(r.market,r.lpSupply,r.lpLocked,r.mode,b,r.fees);approval={id:randomBytes(16).toString('hex'),expires:Date.now()+60000,binding:json(q)};respond(res,200,json({approval:approval.id,quote:q}));
  }else if(req.method==='POST'&&req.url==='/action'){
   const b=await bodyOf(req);mutation=true;respond(res,200,json(await action(b)));
  }else if(req.method==='POST'&&req.url==='/stop'){
   respond(res,200,json({stopped:true}));server.close(()=>process.exit(0));
  }else respond(res,404,json({error:'Not found'}));
 }catch(e){const failure=actionFailure(mutation&&mutationStarted,e);if(mutation)approval=null;if(failure.halted)halted=true;respond(res,400,json({error:failure.error}));}
 finally{busy=false;}
});
server.listen(17828,'127.0.0.1',()=>console.log(`\nGHOST Native Lab — ${LOOPBACK_ORIGIN}/\nLocal test funds only. Open the URL in your browser; use Stop lab when finished.\n`));
