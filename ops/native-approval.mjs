/** Offline review and gated, local-only administrator co-signing. Never broadcasts.
 * The shipping review record is null, so co-signing is unavailable in this release.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { V33, inspectNativeRelease, signingAllowed, reviewedRelease } from '../shared/src/ghost-markets/v33-release.ts';
import { createReadRpc } from '../shared/src/ghost-markets/observe.ts';
import { inspectApproval, packApproval } from '../web/src/native-v33/envelope.mjs';
import { mergeWalletWire } from '../protocol/ghost-markets-pilot/wallet/wire.mjs';
const need=(x,why)=>{if(!x)throw Error(why);};
async function load(path,max){const s=await stat(path);need(s.isFile()&&s.size<=max,'Invalid input file');return JSON.parse(await readFile(path,'utf8'));}
async function main(){
 const [action,input,output,keyfile,...extra]=process.argv.slice(2);
 need(input&&extra.length===0&&((action==='review'&&!output&&!keyfile)||(action==='cosign'&&output&&keyfile)), 'Usage: review INPUT.json | cosign INPUT.json OUTPUT.json LOCAL-ADMIN-KEYPAIR (reviewed release only)');
 const v=await inspectApproval(await load(input,10000));
 console.log(JSON.stringify({review:v.summary,existingSignatures:v.signed,approvedRelease:reviewedRelease()!==null,warning:'Public SPL transaction intent only. Review is not authorization, and no transaction is sent.'},null,2));
 if(action==='review')return;
 // Never read a local signing key before the independently reviewed release and live state match.
 need(reviewedRelease()!==null,'Independent review record missing; co-signing refused');
 const endpoint=process.env.GHOST_MAINNET_RPC||'https://api.mainnet-beta.solana.com';need(new URL(endpoint).protocol==='https:','Trusted HTTPS RPC required');
 const rpc=createReadRpc(endpoint),connection=new Connection(endpoint,'finalized');
 const signer=v.spec.kind==='initialize'?V33.upgradeAuthority:V33.admin;
 const first=v.spec.kind==='initialize'?V33.treasury:v.spec.creator;
 need(v.signed.length===1&&v.signed.includes(first)&&!v.signed.includes(signer),'Creator or treasury signature required first; administrator must be missing');
 async function check(){const state=await inspectNativeRelease(rpc);need(signingAllowed(state,v.spec.kind),'Release or authority mismatch');const valid=await connection.isBlockhashValid(v.spec.blockhash,{commitment:'finalized'});need(valid.value,'Blockhash expired');if(v.spec.kind==='launch')need(!(await connection.getAccountInfo(new PublicKey(v.summary.market),'finalized')),'Market already exists');}
 await check();need(stdin.isTTY,'Interactive confirmation required');
 const rl=createInterface({input:stdin,output:stdout});let typed;try{typed=await rl.question('Type the program ID to confirm local co-signing (NO submission): ');}finally{rl.close();}
 need(typed===V33.programId,'Cancelled');await check();
 const bytes=await load(keyfile,1024);need(Array.isArray(bytes)&&bytes.length===64&&bytes.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'Invalid local keypair format');
 const secret=Uint8Array.from(bytes);bytes.fill(0);
 try{const wallet=Keypair.fromSecretKey(secret);need(wallet.publicKey.toBase58()===signer,'Local key does not match the required authority');const tx=Transaction.from(v.wire);tx.partialSign(wallet);const updated=await mergeWalletWire(v.wire,Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false})),wallet.publicKey.toBytes());await check();const result=packApproval(v.spec,updated);await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log('Local co-signature saved. Return the approval file to the requesting wallet. No transaction sent.');}finally{secret.fill(0);}
}
main().catch(e=>{console.error(String(e?.message??'Approval refused').slice(0,240));process.exitCode=1;});
