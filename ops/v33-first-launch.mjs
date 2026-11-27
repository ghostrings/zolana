/** Explicit operator-only, first native market creation. No buys or trading.
 * Does not enable public website signing or assert a security audit.
 */
import {readFile,writeFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {createHash,randomBytes} from 'node:crypto';
import {Connection,Keypair,PublicKey,Transaction,SystemProgram,NonceAccount} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,unpackMint,unpackAccount,MINT_SIZE,ACCOUNT_SIZE} from '@solana/spl-token';
import bs58 from 'bs58';
import {V33,inspectNativeRelease,scanV33,decodeV33Market,launchIntent,signingAllowed} from '../shared/src/ghost-markets/v33-release.ts';
import {createReadRpc} from '../shared/src/ghost-markets/observe.ts';
import {LIVE_SLOT,launchNonceAddress,launchSpec,canonicalLaunch,inspectLaunch,packLaunch} from '../web/src/native-v33/launch-nonce-envelope.mjs';
import {mergeWalletWire} from '../protocol/ghost-markets-pilot/wallet/wire.mjs';
const endpoint='https://api.mainnet-beta.solana.com',rpc=createReadRpc(endpoint),c=new Connection(endpoint,'confirmed');
const admin=new PublicKey(V33.admin),authorityPath=join(homedir(),'.config/ghost-markets/mainnet-v27/deployer.json');
const need=(x,msg)=>{if(!x)throw Error(msg);};
async function state(){
 const bin=await readFile(new URL('../deployments/mainnet/v33-release/ghost_markets.so',import.meta.url));need(bin.length===V33.binaryBytes&&createHash('sha256').update(bin).digest('hex')===V33.binarySha256,'Local V33 artifact mismatch');
 const s=await inspectNativeRelease(rpc);need(s.release==='v33'&&s.deploymentSlot===LIVE_SLOT&&s.config?.mode==='active','Expected exact active V33 deployment; inspect protocol status');return s;
}
async function empty(){const s=await state(),scan=await scanV33(rpc);need(scan.markets.length===0,'First-launch tool refuses a second market; inspect existing markets');return s;}
async function nonce(commitment='finalized',minContextSlot){
 const addr=await launchNonceAddress(),r=await c.getAccountInfoAndContext(addr,{commitment,...(minContextSlot===undefined?{}:{minContextSlot})});
 const a=r.value;need(a&&a.owner.equals(SystemProgram.programId)&&!a.executable&&a.data.length===80&&a.data.readUInt32LE(0)===1&&a.data.readUInt32LE(4)===1,'Existing initialized nonce account required');
 const n=NonceAccount.fromAccountData(a.data);need(n.authorizedPubkey.equals(admin),'Nonce authority mismatch');return {nonceAccount:addr.toBase58(),nonceValue:n.nonce,nonceSlot:r.context.slot};
}
async function fresh(v){await empty();const n=await nonce('confirmed',v.spec.nonceSlot);need(n.nonceAccount===v.spec.nonceAccount&&n.nonceValue===v.spec.nonceValue,'Nonce changed; inspect chain before new draft');
 const infos=await c.getMultipleAccountsInfo([v.keys.market,v.keys.baseMint,v.keys.lpMint,v.keys.baseVault,v.keys.quoteVault,v.keys.lpLock],'confirmed');need(infos.every(x=>x===null),'Market accounts already exist');
 // Explicit account rent: one 611-byte market, two SPL mints and three SPL vaults.
 const rents=await Promise.all([611,MINT_SIZE,ACCOUNT_SIZE].map(x=>c.getMinimumBalanceForRentExemption(x,'confirmed')));
 need(rents.every(x=>Number.isSafeInteger(x)&&x>=0),'Invalid rent estimate');const rent=rents[0]+2*rents[1]+3*rents[2];
 const fee=await c.getFeeForMessage(v.tx.compileMessage(),'confirmed');need(Number.isSafeInteger(fee.value)&&fee.value>=0,'Fee unavailable');
 const balance=await c.getBalance(new PublicKey(v.spec.creator),'confirmed');need(balance>=rent+fee.value,'Creator wallet lacks SOL for market account rent and fee');
 return {creatorRentEstimateLamports:rent,transactionFeeLamports:fee.value,creatorBalanceLamports:balance};
}
async function loadAuthority(){const s=await stat(authorityPath);need(s.isFile()&&s.size<1024,'Unexpected local authority file');const a=JSON.parse(await readFile(authorityPath,'utf8'));need(Array.isArray(a)&&a.length===64&&a.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'Invalid authority keypair');const raw=Uint8Array.from(a);a.fill(0);try{const k=Keypair.fromSecretKey(raw);need(k.publicKey.equals(admin),'Wrong administrator key');return {k,clear:()=>raw.fill(0)};}catch(e){raw.fill(0);throw e;}}
async function confirmation(v){need(stdin.isTTY,'Interactive terminal required');const phrase=`LAUNCH ${v.summary.market}`,r=createInterface({input:stdin,output:stdout});let reply;try{reply=await r.question(`Type ${phrase} to authorize this single public mint: `);}finally{r.close();}need(reply===phrase,'Cancelled');}
async function finalize(tx,minContextSlot){need(tx.verifySignatures()&&tx.signature,'Invalid signatures');const sig=bs58.encode(tx.signature);console.log('Expected signature:',sig);try{const actual=await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0,minContextSlot});need(actual===sig,'RPC signature mismatch');const until=Date.now()+120_000;while(Date.now()<until){const r=(await c.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];if(r?.err)throw Error('Transaction failed: '+JSON.stringify(r.err));if(r?.confirmationStatus==='finalized')return sig;await new Promise(r=>setTimeout(r,1500));}throw Error('Finality not observed');}catch(e){console.error('Check this signature and on-chain market before retrying: '+sig);throw e;}}
async function receipt(v,sig){
 const read=await c.getAccountInfoAndContext(v.keys.market,'finalized');need(read.value,'Finalized market missing; check signature');const a=read.value;
 const market=decodeV33Market(v.summary.market,{owner:a.owner.toBase58(),executable:a.executable,data:[a.data.toString('base64'),'base64']});
 need(market.creator===v.spec.creator&&market.baseMint===v.summary.mint&&market.name===v.spec.name&&market.symbol===v.spec.symbol&&market.feeBps===v.spec.feeBps,'Unexpected market identity');
 const [mintInfo,vaultInfo]=await c.getMultipleAccountsInfo([v.keys.baseMint,v.keys.baseVault],'finalized');const mint=unpackMint(v.keys.baseMint,mintInfo,TOKEN_PROGRAM_ID),vault=unpackAccount(v.keys.baseVault,vaultInfo,TOKEN_PROGRAM_ID);
 need(mint.isInitialized&&mint.decimals===6&&mint.mintAuthority===null&&mint.freezeAuthority===null&&vault.mint.equals(v.keys.baseMint)&&vault.owner.equals(v.keys.market),'Unexpected mint/vault authorities');
 // A subsequent transaction could already have changed public reserves; do not assert a historical current balance.
 console.log(JSON.stringify({signature:sig,slot:read.context.slot,market,observedSupply:String(mint.supply),observedBaseVault:String(vault.amount),privateSettlement:false,privacyInterface:'not checked',independentSecurityReview:'not asserted',warning:'Public market created. Do not solicit customer funds pending independent review.'},null,2));
}
async function main(){const [action,...args]=process.argv.slice(2);
 if(action==='status'&&args.length===0){const s=await state();console.log(JSON.stringify({observation:s,scan:await scanV33(rpc),nonce:await nonce(),publicWebsiteSigning:signingAllowed(s,'buy'),privateSettlement:false},null,2));return;}
 if((action==='draft'&&args.length===5)||(action==='draft-intent'&&args.length===2)){
   let intent;const file=args[0];
   if(action==='draft'){const [,creator,name,symbol,tier]=args;intent=launchIntent(creator,name,symbol,Number(tier));}
   else{const st=await stat(args[1]);need(st.isFile()&&st.size<=10000,'Invalid intent file');const i=JSON.parse(await readFile(args[1],'utf8'));need(i&&typeof i==='object'&&!Array.isArray(i),'Invalid intent');intent=launchIntent(i.creator,i.name,i.symbol,i.feeBps);need(Object.keys(i).length===Object.keys(intent).length&&Object.entries(intent).every(([k,val])=>i[k]===val),'Intent does not match pinned launch policy');}
   const values={...intent,nonce:String(randomBytes(8).readBigUInt64LE())};await empty();const spec=await launchSpec(values,await nonce()),v=await canonicalLaunch(spec);const costs=await fresh({...v,spec});console.log(JSON.stringify({...v.summary,...costs},null,2));await writeFile(file,JSON.stringify(packLaunch(spec,v.unsigned),null,2)+'\n',{flag:'wx',mode:0o600});console.log('Unsigned launch draft saved; no keys read or funds spent.');return;
 }
 if(action==='submit'&&args.length===1){const f=await stat(args[0]);need(f.isFile()&&f.size<=10000,'Invalid approval file');const v=await inspectLaunch(JSON.parse(await readFile(args[0],'utf8')));need(v.signed.length===1&&v.signed[0]===v.spec.creator,'Exactly the creator signature is required');const costs=await fresh(v);console.log(JSON.stringify({...v.summary,...costs},null,2));console.log('UNAUDITED OWNER PILOT: public SPL issuance only. Real creator SOL is spent on account rent and transaction fees. No first buy, shielding, or customer deposit.');await confirmation(v);await fresh(v);const {k,clear}=await loadAuthority();let sig;try{const tx=Transaction.from(v.wire);tx.partialSign(k);const merged=await mergeWalletWire(v.wire,Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false})),k.publicKey.toBytes());sig=await finalize(Transaction.from(merged),v.spec.nonceSlot);}finally{clear();}console.log('Finalized signature:',sig);await receipt(v,sig);return;}
 throw Error('Usage: status | draft OUTPUT.json CREATOR_PUBLIC_ADDRESS "Token Name" SYMBOL 200|300|400 | draft-intent OUTPUT.json UNSIGNED_INTENT.json | submit CREATOR_APPROVAL.json');}
main().catch(e=>{console.error(String(e?.message??'Operation refused').slice(0,500));process.exitCode=1;});
