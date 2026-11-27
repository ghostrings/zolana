/** Owner-operated Default Ring asset registration, only for a verified native market.
 * Registration is public, creates the SPL interface only, and never deposits or trades.
 */
import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';import {stdin,stdout} from 'node:process';
import {Connection,Keypair,PublicKey,Transaction,TransactionInstruction,VersionedTransaction,TransactionMessage} from '@solana/web3.js';
import {address} from '@solana/kit';import {getCreateSplInterfaceInstructionAsync} from '@heliuslabs/spr/instructions';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';import bs58 from 'bs58';
import {V33,inspectNativeRelease,scanV33,isKnownNativeRelease} from '../shared/src/ghost-markets/v33-release.ts';import {createReadRpc} from '../shared/src/ghost-markets/observe.ts';
import {SPP_PROGRAM_ID} from '../shared/src/constants.ts';import {legacyInstructionFields} from '../shared/src/tx.ts';
import {readNativeAsset} from '../shared/src/native-asset.ts';import {context,marketKeys} from '../web/src/native-v33/instructions.mjs';import {LIVE_SLOT} from '../web/src/native-v33/launch-nonce-envelope.mjs';
const need=(v,msg)=>{if(!v)throw Error(msg);};const endpoint='https://api.mainnet-beta.solana.com',rpc=createReadRpc(endpoint),c=new Connection(endpoint,'confirmed'),payer=new PublicKey(V33.admin);
async function marketState(marketAddress){const s=await inspectNativeRelease(rpc);need(isKnownNativeRelease(s)&&s.config,'Expected initialized exact native deployment');const {slot,markets}=await scanV33(rpc),m=markets.find(m=>m.address===marketAddress);need(m,'Market not found in verified scan');const k=marketKeys(context,new PublicKey(m.creator),BigInt(m.nonce));need(k.market.toBase58()===m.address&&k.baseMint.toBase58()===m.baseMint,'Market PDA mismatch');return {m,asset:await readNativeAsset(c,m.baseMint,slot)};}
async function main(){const [action,market,max,...extra]=process.argv.slice(2);need(market&&extra.length===0&&((action==='status'&&max===undefined)||(action==='register'&&max!==undefined)),'Usage: status MARKET_ADDRESS | register MARKET_ADDRESS MAX_ESTIMATED_LAMPORTS');new PublicKey(market);let v=await marketState(market);console.log(JSON.stringify({market:v.m.address,name:v.m.name,symbol:v.m.symbol,creator:v.m.creator,asset:v.asset,privateSettlement:false},null,2));if(action==='status'||v.asset.state==='registered')return;
 need(v.asset.state==='registration-available','Registration is restricted or unavailable; stop. No transaction sent.');
 need(/^[1-9][0-9]{0,8}$/.test(max)&&Number(max)<=100_000_000,'Maximum estimated debit must be 1–100000000 lamports (0.1 SOL)');const limit=Number(max);
 async function build(){v=await marketState(market);need(v.asset.state==='registration-available','Asset state changed; inspect status');
   const f=legacyInstructionFields(await getCreateSplInterfaceInstructionAsync({authority:address(V33.admin),mint:address(v.m.baseMint),tokenProgram:address(TOKEN_PROGRAM_ID.toBase58())}));
   need(f.programId===SPP_PROGRAM_ID&&f.keys.some(k=>k.pubkey===v.m.baseMint)&&f.keys.some(k=>k.pubkey===v.asset.registry)&&f.keys.filter(k=>k.isSigner).every(k=>k.pubkey===V33.admin)&&f.keys.some(k=>k.isSigner&&k.pubkey===V33.admin),'Unexpected SDK interface instruction');
   const ix=new TransactionInstruction({programId:new PublicKey(f.programId),keys:f.keys.map(k=>({pubkey:new PublicKey(k.pubkey),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(f.data)});
   const bh=await c.getLatestBlockhash('confirmed'),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:bh.blockhash,instructions:[ix]}).compileToLegacyMessage());
   const balance=await c.getBalance(payer,'confirmed'),sim=await c.simulateTransaction(tx,{commitment:'confirmed',sigVerify:false,accounts:{encoding:'base64',addresses:[V33.admin]}});
   need(!sim.value.err&&sim.value.accounts?.[0]&&Number.isSafeInteger(sim.value.accounts[0].lamports),'Registration simulation failed; inspect protocol permissions and RPC');
   const fee=await c.getFeeForMessage(tx.message,'confirmed');need(Number.isSafeInteger(fee.value)&&fee.value>=0,'Fee unavailable');
   // RPC reads may occur at different slots. Treat the balance delta plus fee as a conservative estimate, not an on-chain debit cap.
   const estimate=Math.max(0,balance-sim.value.accounts[0].lamports)+fee.value;need(estimate<=limit&&balance>=estimate,'Estimated payer debit exceeds selected budget');return {tx,bh,estimate,fee:fee.value};
 }
 let b=await build();console.log(JSON.stringify({network:'mainnet-beta',action:'create SPL asset interface only',mint:v.m.baseMint,registry:v.asset.registry,payer:V33.admin,estimatedDebitLamports:b.estimate,maxEstimatedDebitLamports:limit,warning:'Real SOL; simulation estimate only, not a hard on-chain cap. No token deposit or trade.'},null,2));
 need(stdin.isTTY,'Interactive terminal required');const phrase=`REGISTER ${v.m.baseMint}`,rl=createInterface({input:stdin,output:stdout});let reply;try{reply=await rl.question(`Type ${phrase} to continue: `);}finally{rl.close();}need(reply===phrase,'Cancelled');
 b=await build();const path=join(homedir(),'.config/ghost-markets/mainnet-v27/deployer.json'),st=await stat(path);need(st.isFile()&&st.size<1024,'Invalid local key file');const a=JSON.parse(await readFile(path,'utf8'));need(Array.isArray(a)&&a.length===64&&a.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'Invalid keypair');const raw=Uint8Array.from(a);a.fill(0);let signature;
 try{const k=Keypair.fromSecretKey(raw);need(k.publicKey.equals(payer),'Wrong payer');b.tx.sign([k]);signature=bs58.encode(b.tx.signatures[0]);console.log('Expected signature:',signature);const actual=await c.sendRawTransaction(b.tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});need(actual===signature,'RPC signature mismatch');const result=await c.confirmTransaction({...b.bh,signature},'finalized');need(!result.value.err,'Registration failed; inspect signature');}catch(e){if(signature)console.error('Check transaction before retry: '+signature);throw e;}finally{raw.fill(0);}
 const end=await marketState(market);need(end.asset.state==='registered','Registration not verified; inspect chain');console.log(JSON.stringify({signature,asset:end.asset,privateSettlement:false,warning:'Registered asset interface only. No private balance, deposit or private swap was created.'},null,2));
}
main().catch(e=>{console.error(String(e?.message??'Operation refused').slice(0,400));process.exitCode=1;});
