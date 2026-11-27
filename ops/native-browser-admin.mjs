/** Operator-only loopback signer. Not part of Render or any public build.
 * No signing service exposed on a LAN; no arbitrary message, key path, or submit endpoint.
 */
import {createServer} from 'node:http';import {readFile,stat} from 'node:fs/promises';import {homedir} from 'node:os';import {join} from 'node:path';import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {Connection,Keypair,Transaction} from '@solana/web3.js';
import {V33} from '../shared/src/ghost-markets/v33-release.ts';import {createReadRpc} from '../shared/src/ghost-markets/observe.ts';
import {inspectBrowserLaunch,packBrowserLaunch,launchPreflight} from '../web/src/native-v33/browser-launch.mjs';import {metadataReadPath} from '../web/src/native-v33/launch-policy.mjs';
import {mergeWalletWire} from '../protocol/ghost-markets-pilot/wallet/wire.mjs';
const origin='http://127.0.0.1:17831',host='127.0.0.1:17831',token=randomBytes(32).toString('hex'),endpoint='https://api.mainnet-beta.solana.com';
const c=new Connection(endpoint,'confirmed'),rpc=createReadRpc(endpoint),need=(x,msg)=>{if(!x)throw Error(msg);};
const path=join(homedir(),'.config/ghost-markets/mainnet-v27/deployer.json');
const files=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
let busy=false;
async function inspect(envelope){
 const v=await inspectBrowserLaunch(envelope);need(v.signed.length===1&&v.signed[0]===v.spec.creator,'Exactly the creator signature must be present');
 const bin=await readFile(new URL('../deployments/mainnet/v33-release/ghost_markets.so',import.meta.url));need(bin.length===V33.binaryBytes&&createHash('sha256').update(bin).digest('hex')===V33.binarySha256,'Local V33 executable mismatch');
 const costs=await launchPreflight(c,rpc,v);const route=metadataReadPath(v.spec.metadataUri);need(route,'Unrecognized metadata URI');
 const r=await fetch('https://privacycash.fun'+route,{redirect:'error',signal:AbortSignal.timeout(10000)});need(r.ok,'Metadata unavailable on the canonical website');const raw=await r.text();need(raw.length<=16384,'Metadata too large');const meta=JSON.parse(raw);need(meta.name===v.spec.name&&meta.symbol===v.spec.symbol,'Metadata name or symbol changed');
 const review={...v.summary,...costs,description:typeof meta.description==='string'?meta.description.slice(0,500):'',image:typeof meta.image==='string'?meta.image.slice(0,300):'',phrase:`APPROVE ${v.summary.market}`,independentSecurityReview:'not asserted',warning:'This is a durable, real public issuance approval. No transaction sent here.'};return {v,review};
}
async function approve(body){const {v,review}=await inspect(body.envelope);need(body.ack===true&&body.phrase===review.phrase,'Explicit matching approval phrase required');const st=await stat(path);need(st.isFile()&&st.size<1024,'Unexpected local administrator key file');const a=JSON.parse(await readFile(path,'utf8'));need(Array.isArray(a)&&a.length===64&&a.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'Invalid local administrator key');const raw=Uint8Array.from(a);a.fill(0);try{const k=Keypair.fromSecretKey(raw);need(k.publicKey.toBase58()===V33.admin,'Wrong local administrator key');const tx=Transaction.from(v.wire);tx.partialSign(k);const merged=await mergeWalletWire(v.wire,Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false})),k.publicKey.toBytes());const envelope=packBrowserLaunch(v.spec,merged),checked=await inspectBrowserLaunch(envelope);need(checked.signed.length===2&&checked.tx.serializeMessage().equals(v.tx.serializeMessage()),'Signature verification failed');return {envelope};}finally{raw.fill(0);}}
function reply(res,status,body){res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(body));}
const server=createServer(async(req,res)=>{
 res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");res.setHeader('x-frame-options','DENY');
 if(req.headers.host!==host||req.socket.remoteAddress!=='127.0.0.1')return reply(res,403,{error:'Loopback only'});
 try{if(req.method==='GET'&&files.has(req.url)){const [name,type]=files.get(req.url),content=await readFile(new URL('./native-admin/'+name,import.meta.url),'utf8');res.setHeader('content-type',type);res.end(name==='index.html'?content.replace('__TOKEN__',token):content);return;}
 const presented=req.headers['x-ghost-operator-token'];if(req.method!=='POST'||!['/inspect','/approve'].includes(req.url)||req.headers.origin!==origin||req.headers['content-type']!=='application/json'||typeof presented!=='string'||presented.length!==token.length||!timingSafeEqual(Buffer.from(presented),Buffer.from(token)))return reply(res,403,{error:'Operator request refused'});
 if(busy)return reply(res,409,{error:'Another review is running'});busy=true;try{let b='';for await(const chunk of req){b+=chunk.toString();if(b.length>20000)return reply(res,413,{error:'Approval too large'});}const body=JSON.parse(b);need(body&&typeof body==='object'&&!Array.isArray(body),'Invalid approval request');if(req.url==='/inspect'){const {review}=await inspect(body.envelope);return reply(res,200,review);}return reply(res,200,await approve(body));}finally{busy=false;}
 }catch(e){reply(res,400,{error:String(e?.message??'Review refused').slice(0,400)});}
});server.requestTimeout=30000;server.listen(17831,'127.0.0.1',()=>console.log(`Local GHOST approval page: ${origin}/\nNo transaction submission. Keep this process local; stop it after use.`));
