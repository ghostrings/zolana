/** Local operator only. Exact known V33 -> V41 cutover; never a security review.
 * All writes require an explicit terminal confirmation. No production key goes to Render.
 */
import {readFileSync,writeFileSync,mkdirSync,existsSync,mkdtempSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {Connection,PublicKey,Keypair,Transaction,TransactionInstruction,VersionedTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,unpackAccount,unpackMint} from '@solana/spl-token';
import bs58 from 'bs58';
import {V33,V41_CANDIDATE as C,V41_EXTENSION_BYTES,V41_EXTENSION_CAPACITY,isV33Extended,isKnownNativeRelease,parseV41OwnerRelease,v41OwnerRelease,inspectNativeRelease,decodeV33Market,scanV33} from '../shared/src/ghost-markets/v33-release.ts';
import {createReadRpc} from '../shared/src/ghost-markets/observe.ts';
import {marketKeys,context} from '../web/src/native-v33/instructions.mjs';
import {observeSignature} from '../web/src/native-v33/finality.mjs';
const need=(ok,msg)=>{if(!ok)throw Error(msg);},pk=x=>new PublicKey(x),sha=b=>createHash('sha256').update(b).digest('hex');
const endpoint='https://api.mainnet-beta.solana.com',rpc=createReadRpc(endpoint),connection=new Connection(endpoint,'finalized');
const root=resolve(import.meta.dirname,'..'),rel=resolve(root,'deployments/review/v41-candidate');
const evidence=resolve(homedir(),'.config/ghost-markets/v41-cutover'),beforePath=resolve(evidence,'before.json');
const originalPath=resolve(evidence,'before-extension.json');
const authPath=resolve(homedir(),'.config/ghost-markets/mainnet-v27/deployer.json');
const knownMarket='AqwuGpwStiafXGnwqxEQ1sdqnPodnytvWrzU71odCrrg';
const record={kind:'owner-authorized-unaudited-v41',enabled:true,programId:C.programId,binarySha256:C.binarySha256,binaryBytes:C.binaryBytes,previousDeploymentSlot:C.previousDeploymentSlot,independentReview:false,privateSettlement:false};
const immutable=m=>Object.fromEntries(['address','creator','nonce','baseMint','quoteMint','lpMint','baseVault','quoteVault','lpLock','virtualQuote','graduationQuote','initialSupply','feeBps','treasury','name','symbol','metadataUri'].map(k=>[k,m[k]]));
function candidate(){
 const bin=readFileSync(resolve(rel,'ghost_markets.so'));need(bin.length===C.binaryBytes&&sha(bin)===C.binarySha256,'Candidate binary mismatch');
 const meta=JSON.parse(readFileSync(resolve(rel,'candidate.json'),'utf8'));need(meta.binarySha256===C.binarySha256&&meta.programId===C.programId&&meta.solanaVerifyHash===C.verifyHash&&meta.binaryBytes===C.binaryBytes&&JSON.stringify(meta.buildFeatures)==='["public-v41"]','Candidate manifest mismatch');
 execFileSync('sha256sum',['-c','SHA256SUMS'],{cwd:rel,stdio:'inherit'});
 return meta;
}
async function prompt(expected){const rl=createInterface({input:process.stdin,output:process.stdout});try{need((await rl.question(`Type ${expected} to confirm: `))===expected,'Cancelled');}finally{rl.close();}}
async function observe(release,mode){const o=await inspectNativeRelease(rpc);need(o.protocolInitialized&&o.config&&(!release||o.release===release)&&(!mode||o.config.mode===mode),`Expected ${release??'native'} / ${mode??'any mode'}, observed ${o.release} / ${o.config?.mode??'uninitialized'}. Do not deploy.`);need(isKnownNativeRelease(o),'Unrecognized deployment slot or allocation; stop for review');return o;}
async function snapshot(release,mode){
 const o=await observe(release,mode),s=await scanV33(rpc);need(s.markets.some(m=>m.address===knownMarket),'Known ZOL market missing');
 const markets=[];
 for(const old of s.markets){
   const k=marketKeys(context,pk(old.creator),BigInt(old.nonce));
   for(const name of ['baseMint','quoteMint','lpMint','baseVault','quoteVault','lpLock'])need(k[name].toBase58()===old[name],'Market PDA mismatch');need(k.market.toBase58()===old.address,'Market address mismatch');
   const f=await connection.getMultipleAccountsInfoAndContext([k.market,k.baseVault,k.quoteVault,k.lpLock,k.baseMint,k.lpMint],{commitment:'finalized',minContextSlot:s.slot});
   need(f.context.slot>=s.slot&&f.value.every(Boolean),'Market/vault read unavailable');
   const [ma,ba,qa,la,bma,lma]=f.value;
   const m=decodeV33Market(old.address,{owner:ma.owner.toBase58(),executable:ma.executable,data:[ma.data.toString('base64'),'base64']});
   need(JSON.stringify(immutable(m))===JSON.stringify(immutable(old)),'Market identity changed');
   const [b,q,l]=[unpackAccount(k.baseVault,ba,TOKEN_PROGRAM_ID),unpackAccount(k.quoteVault,qa,TOKEN_PROGRAM_ID),unpackAccount(k.lpLock,la,TOKEN_PROGRAM_ID)];
   const bm=unpackMint(k.baseMint,bma,TOKEN_PROGRAM_ID),lm=unpackMint(k.lpMint,lma,TOKEN_PROGRAM_ID);
   need([b,q,l].every(t=>t.owner.equals(k.market)&&!t.isFrozen)&&b.mint.equals(k.baseMint)&&q.mint.equals(NATIVE_MINT)&&l.mint.equals(k.lpMint),'Vault ownership/mint mismatch');
   need(b.amount>=BigInt(m.baseReserve)&&q.amount>=BigInt(m.quoteReserve)+BigInt(m.platformFees)+BigInt(m.creatorFees),'Vault accounting mismatch');
   need(bm.decimals===6&&bm.mintAuthority===null&&bm.freezeAuthority===null&&bm.supply<=BigInt(m.initialSupply)-BigInt(m.burned)&&bm.supply>=b.amount,'Base mint invalid');
   need(lm.decimals===6&&lm.mintAuthority?.equals(k.market)&&lm.supply===l.amount&&l.amount===BigInt(m.lockedLp),'LP lock invalid');
   markets.push({market:m,slot:f.context.slot,baseVault:String(b.amount),quoteVault:String(q.amount),lpLock:String(l.amount),mintSupply:String(bm.supply),lpSupply:String(lm.supply)});
 }
 const after=await observe(release,mode);need(after.binarySha256===o.binarySha256&&after.deploymentSlot===o.deploymentSlot,'Deployment changed during snapshot');
 return {observation:after,scanSlot:s.slot,markets,note:'Public finalized accounting checks only. Trades/claims/exits can change balances while paused; immutable identities and solvency checked.'};
}
function sameMarkets(prior,current){
 need(prior.markets.length===current.markets.length,'Market count changed while paused; investigate');
 const old=new Map(prior.markets.map(x=>[x.market.address,immutable(x.market)]));
 for(const x of current.markets)need(JSON.stringify(old.get(x.market.address))===JSON.stringify(immutable(x.market)),'Existing market identity/economics changed');
}
function readSnapshot(path,extended){const s=JSON.parse(readFileSync(path,'utf8'));const o=s.observation;need(o.release==='v33'&&o.config.mode==='paused'&&o.binarySha256===V33.binarySha256&&(extended?isV33Extended(o):o.deploymentSlot===C.previousDeploymentSlot),'Missing exact paused V33 snapshot');return s;}
async function postflight(){
 const original=readSnapshot(originalPath,false),prior=readSnapshot(beforePath,true);
 const current=await snapshot('v41','paused');
 need(BigInt(current.observation.deploymentSlot)>BigInt(prior.observation.deploymentSlot),'V41 deployment slot did not advance');
 sameMarkets(original,prior);sameMarkets(prior,current);
 console.log(JSON.stringify(current,null,2));writeFileSync(resolve(evidence,'after.json'),JSON.stringify(current,null,2)+'\n',{mode:0o600});return current;
}
async function websiteStaged(observation){
 const r=await fetch('https://privacycash.fun/api/ghost-markets/v33/status',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});need(r.ok,'Production website not reachable');
 const s=await r.json();need(s.verification==='matched'&&s.observation?.release===observation.release&&s.observation.binarySha256===observation.binarySha256&&s.observation.deploymentSlot===observation.deploymentSlot&&s.observation.config?.mode===observation.config.mode&&s.signing===true&&s.v41Cutover?.binarySha256===C.binarySha256&&s.v41Cutover?.ownerAuthorized===true&&s.v41Cutover?.extensionCapacityBytes===V41_EXTENSION_CAPACITY,'Deploy the explicitly authorized staged V41 website first; if recently deployed, allow the status cache to refresh');
}
async function setMode(action){
 const stopping=action==='pause'||action==='emergency-pause',from=stopping?'active':'paused',next=stopping?2:1;
 candidate();if(action==='pause'||action==='resume')need(v41OwnerRelease(),'First explicitly authorize the V41 website release');
 const original=await observe(action==='pause'||action==='resume-v33'?'v33':action==='resume'?'v41':undefined,from);
 const release=original.release;need(release==='v33'||release==='v41','Operational market program required');
 if(action==='resume')await postflight();
 if(action==='resume-v33')await snapshot('v33','paused');
 if(action==='pause'||action==='resume'||action==='resume-v33')await websiteStaged(original);
 console.log(JSON.stringify({action,network:'mainnet-beta',programId:V33.programId,protocol:V33.protocol,signer:V33.admin,from,next:next===1?'active':'paused',independentReview:false,privateSettlement:false,warning:action==='resume'?'Real funds at risk. Opens permissionless launches and public buys; V33 rollback not safe after new-profile markets.':action==='resume-v33'?'Resumes the unchanged V33 program, not a rollback. Real funds at risk.':'Real network fee; pause blocks buys/new launches, not legitimate sells/claims/graduation.'},null,2));
 await prompt(`${action.toUpperCase()} V41 ${V33.programId}`);
 const fresh=await observe(release,from);need(fresh.deploymentSlot===original.deploymentSlot,'Deployment changed');
 // Read the existing private key only on the operator computer, after explicit confirmation.
 const raw=Uint8Array.from(JSON.parse(readFileSync(authPath,'utf8')));
 try{
   const signer=Keypair.fromSecretKey(raw);need(signer.publicKey.toBase58()===V33.admin,'Wrong admin key');
   const idl=JSON.parse(readFileSync(resolve(rel,'ghost_markets.json'),'utf8')),ix=idl.instructions.find(x=>x.name==='set_protocol_mode');
   need(ix?.accounts.map(a=>a.name).join(',')==='authority,protocol'&&ix.discriminator.length===8,'Unexpected mode instruction');
   const instruction=new TransactionInstruction({programId:pk(V33.programId),keys:[{pubkey:signer.publicKey,isSigner:true,isWritable:false},{pubkey:pk(V33.protocol),isSigner:false,isWritable:true}],data:Buffer.from([...ix.discriminator,next])});
   const bh=await connection.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:signer.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(instruction);
   const sim=await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{sigVerify:false,commitment:'confirmed'});need(sim.value.err===null,'Mode-change simulation failed');
   tx.sign(signer);need(tx.verifySignatures()&&tx.signature,'Local signature invalid');const expected=bs58.encode(tx.signature);console.log('Expected signature:',expected);
   const actual=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});need(actual===expected,'Unexpected RPC signature');
   const receipt=await observeSignature(connection,expected,{timeoutMs:120000});need(receipt.status==='finalized','Finality not established; check signature before any retry');
   console.log(JSON.stringify(await observe(release,next===1?'active':'paused'),null,2));
 }finally{raw.fill(0);}
}
async function preflight(){
 const s=await snapshot('v33','paused');await websiteStaged(s.observation);
 const extended=isV33Extended(s.observation),pd=await connection.getAccountInfo(pk(V33.programData),'finalized');
 need(pd&&pd.owner.toBase58()==='BPFLoaderUpgradeab1e11111111111111111111111'&&pd.data.length===45+(extended?V41_EXTENSION_CAPACITY:V33.binaryBytes),'Unexpected ProgramData capacity; do not deploy');
 need(pd.data.readBigUInt64LE(4).toString()===s.observation.deploymentSlot&&sha(pd.data.subarray(45,45+V33.binaryBytes))===V33.binarySha256&&pd.data.subarray(45+V33.binaryBytes).every(x=>x===0),'ProgramData changed during preflight');
 const [rent,buffer,balance]=await Promise.all([connection.getMinimumBalanceForRentExemption(45+V41_EXTENSION_CAPACITY,'finalized'),connection.getMinimumBalanceForRentExemption(37+C.binaryBytes,'finalized'),connection.getBalance(pk(V33.admin),'finalized')]);
 const estimate=Math.max(0,rent-pd.lamports)+buffer;need(balance>=estimate+10_000_000,'Insufficient estimated funding including 0.01 SOL headroom');
 const path=extended?beforePath:originalPath;
 if(extended){sameMarkets(readSnapshot(originalPath,false),s);}else if(existsSync(originalPath)){sameMarkets(readSnapshot(originalPath,false),s);}
 // Preserve the original pre-extension snapshot; refresh the extended pre-deploy snapshot.
 if(extended||!existsSync(path))writeFileSync(path,JSON.stringify(s,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({observation:s.observation,markets:s.markets.length,allocation:{currentBytes:pd.data.length-45,requiredBytes:C.binaryBytes,targetBytes:V41_EXTENSION_CAPACITY,extensionBytes:extended?0:V41_EXTENSION_BYTES,estimatedAdditionalLamports:estimate,feePayerLamports:balance,headroomLamports:balance-estimate},candidate:C,warning:'Read-only chain checks, not an audit. No transaction sent.'},null,2));
 console.log(extended?'PREFLIGHT PASSED — EXTENDED V33, READY FOR GUARDED DEPLOY':'PREFLIGHT PASSED — PAUSED V33, EXTENSION REQUIRED');console.log('Paused snapshot:',path);return s;
}
function cliAuthority(){need(execFileSync('solana-keygen',['pubkey',authPath],{encoding:'utf8'}).trim()===V33.admin,'Wrong local upgrade authority');}
function solana(args){execFileSync('solana',['--url',endpoint,'--keypair',authPath,'--commitment','finalized',...args],{stdio:'inherit'});}
async function extendProgram(){
 const first=await preflight();need(!isV33Extended(first.observation),'Already extended; do not extend again');
 await prompt(`EXTEND ${V41_EXTENSION_BYTES} ${V33.programId}`);const fresh=await preflight();need(fresh.observation.deploymentSlot===first.observation.deploymentSlot&&!isV33Extended(fresh.observation),'Deployment changed; stop');cliAuthority();
 solana(['program','extend',V33.programId,String(V41_EXTENSION_BYTES)]);
 const after=await snapshot('v33','paused');need(isV33Extended(after.observation),'Extension not finalized at expected capacity; check status before any retry');sameMarkets(first,after);
 console.log(JSON.stringify(after.observation,null,2));console.log('EXTENSION VERIFIED — V33 CODE UNCHANGED. Wait for staged website status to match, then run preflight.');
}
async function checkOldBuffers(){
 for(const entry of readdirSync(evidence,{withFileTypes:true})){
   if(!entry.isDirectory()||!entry.name.startsWith('buffer-'))continue;
   const marker=resolve(evidence,entry.name,'buffer-public.json');
   need(existsSync(marker),'Previous buffer attempt lacks public metadata; inspect locally before another deployment');
   const {address}=JSON.parse(readFileSync(marker,'utf8'));
   need(!(await connection.getAccountInfo(pk(address),'finalized')),`Prior deployment buffer still exists: ${address}. Inspect/recover it before attempting another deployment.`);
 }
}
async function deployProgram(){
 const first=await preflight();need(isV33Extended(first.observation),'Extension required before deploy');
 await prompt(`DEPLOY UNAUDITED V41 ${C.verifyHash}`);candidate();const fresh=await preflight();need(isV33Extended(fresh.observation)&&fresh.observation.deploymentSlot===first.observation.deploymentSlot,'Deployment changed; stop');cliAuthority();await checkOldBuffers();
 // Explicit, fresh buffer signer: never reuse the exposed seed or print a new mnemonic.
 const dir=mkdtempSync(resolve(evidence,'buffer-')),file=resolve(dir,'buffer-keypair.json'),key=Keypair.generate(),secret=key.secretKey;
 try{writeFileSync(file,JSON.stringify(Array.from(secret)),{mode:0o600,flag:'wx'});}finally{secret.fill(0);}
 writeFileSync(resolve(dir,'buffer-public.json'),JSON.stringify({address:key.publicKey.toBase58()})+'\n',{mode:0o600,flag:'wx'});
 console.log('Fresh buffer public address:',key.publicKey.toBase58());console.log('Private buffer file is retained locally; never upload it or the evidence directory. If deployment fails, check the buffer and program state before retrying.');
 solana(['program','deploy',resolve(rel,'ghost_markets.so'),'--program-id',V33.programId,'--upgrade-authority',authPath,'--buffer',file,'--no-auto-extend']);
 await postflight();console.log('V41 installed and still paused. Verify publication and website before any resume.');
}
async function main(){
 const [action,...rest]=process.argv.slice(2);need(!rest.length&&['status','website','authorize','pause','preflight','extend','deploy','postflight','resume','emergency-pause','resume-v33'].includes(action),'Usage: npx --no-install tsx ops/v41-cutover.mjs status|website|authorize|pause|preflight|extend|deploy|postflight|resume|emergency-pause|resume-v33');
 if(action==='status'){console.log(JSON.stringify(await observe(),null,2));return;}
 if(action==='website'){const o=await observe();await websiteStaged(o);console.log('WEBSITE READY — exact owner-authorized V41 candidate and 10 KiB extension support');return;}
 if(action==='authorize'){
   candidate();await observe('v33','active');need(parseV41OwnerRelease(record),'Invalid release decision');
   console.log(JSON.stringify({...record,warning:'Owner-controlled release, NOT audited. Authorizes only exact V41 candidate bytes on the existing program after V33. No on-chain transaction. Review compatibility and recovery; do not represent this as independent approval.'},null,2));
   await prompt(`AUTHORIZE UNAUDITED V41 ${C.verifyHash}`);
   writeFileSync(resolve(root,'shared/src/ghost-markets/v41-owner-release-record.ts'),`/** Explicit owner release decision, not an independent audit. */\nexport const V41_OWNER_RELEASE_RECORD: unknown = Object.freeze(${JSON.stringify(record,null,2)});\n`);console.log('Owner authorization recorded. Run full tests and deploy this website BEFORE any on-chain upgrade. No transaction sent.');return;
 }
 if(['pause','resume','emergency-pause','resume-v33'].includes(action)){await setMode(action);return;}
 candidate();need(v41OwnerRelease(),'Owner website release decision missing');mkdirSync(evidence,{recursive:true,mode:0o700});
 if(action==='postflight'){await postflight();return;}
 if(action==='preflight'){await preflight();return;}
 if(action==='extend'){await extendProgram();return;}
 if(action==='deploy'){await deployProgram();return;}
 throw Error('Unknown action');
}
main().catch(e=>{console.error(String(e?.message??e).slice(0,350));process.exitCode=1;});
