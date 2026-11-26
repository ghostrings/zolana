import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const folder=process.env.GHOST_MARKETS_SDK_BUILD;
assert.ok(folder,'Use npm run markets:check');
const sdk=await import(pathToFileURL(resolve(folder,'observe.js')).href);
const ix=await import(pathToFileURL(resolve(folder,'local-instructions.js')).href);
const {DEPLOYMENT:D,LOADER,MARKET_BYTES,base58,publicKey,decodeMarket,decodeProtocol,verifyReleaseSnapshot,observeDeployment,createReadRpc,discoverMarkets,lookupMarket,recentActivity}=sdk;
const key=n=>base58(Uint8Array.from({length:32},(_,i)=>(i+n)%256));
const acc=(d,owner=D.programId,executable=false)=>({owner,executable,data:[Buffer.from(d).toString('base64'),'base64']});
const frame=(value,slot=474265600)=>({context:{slot},value});
const tag=n=>createHash('sha256').update(n).digest().subarray(0,8);
function fixture(){
 const binary=Buffer.from('fictional ELF bytes for unit tests only');
 const e={...D,binaryBytes:binary.length,binarySha256:createHash('sha256').update(binary).digest('hex')};
 const p=Buffer.alloc(36);p.writeUInt32LE(2);p.set(publicKey(e.programData),4);
 const pd=Buffer.alloc(45+binary.length);pd.writeUInt32LE(3);pd.writeBigUInt64LE(BigInt(e.deploymentSlot),4);pd[12]=1;pd.set(publicKey(e.upgradeAuthority),13);pd.set(binary,45);
 const accounts=[acc(p,LOADER,true),acc(pd,LOADER),null];
 const rpc=async(method)=>method==='getGenesisHash'?e.genesis:frame(accounts);
 return {e,p,pd,accounts,rpc};
}
function market(){
 const b=Buffer.alloc(MARKET_BYTES);b.set(tag('account:Market'));b[8]=1;b[9]=255;b[10]=2;b.set(publicKey(key(1)),11);b.writeBigUInt64LE(123n,43);
 for(let i=0;i<6;i++)b.set(publicKey(key(i+2)),51+32*i);
 for(const [o,v] of [[243,7n],[251,9007199254740999n],[259,456n],[267,200n],[275,300n],[285,9007199254741100n],[293,10n],[301,5n]])b.writeBigUInt64LE(v,o);
 b.writeUInt16LE(30,283);let p=309;for(const s of ['Test market','TST','https://example.com/test']){const t=Buffer.from(s);b.writeUInt32LE(t.length,p);p+=4;b.set(t,p);p+=t.length;}
 return b;
}
function config(mode=0){const b=Buffer.alloc(107);b.set(tag('account:ProtocolConfig'));b[8]=1;b[10]=mode;b.set(publicKey(key(1)),11);b.set(publicKey(key(2)),43);return b;}
test('public address roundtrip and exact 32-byte validation',()=>{for(const k of [D.programId,D.programData,D.protocol,D.upgradeAuthority,'11111111111111111111111111111111',key(7)])assert.equal(base58(publicKey(k)),k);for(const k of ['','0'.repeat(32),'1'.repeat(33),'A'.repeat(32)])assert.throws(()=>publicKey(k));});
test('pinned deployment record matches reported JSON',()=>{const x=JSON.parse(requireFile('deployments/mainnet/ghost-markets-v27.json'));for(const k of Object.keys(D))assert.equal(x[k],D[k],k);assert.equal(x.evidenceSource,'owner-supplied RPC verification output');});
import { readFileSync as requireFile } from 'node:fs';
test('synthetic release verification accepts exact finalized account bytes',async()=>{const f=fixture();const o=await verifyReleaseSnapshot(f.rpc,f.e);assert.equal(o.binarySha256,f.e.binarySha256);assert.equal(o.protocol,null);assert.equal(o.marketExecution,undefined);assert.equal(o.privateSettlement,undefined);});
test('actual pinned observer rejects synthetic executable and wrong network',async()=>{const f=fixture();await assert.rejects(()=>observeDeployment(f.rpc),/layout or size/);await assert.rejects(()=>observeDeployment(async()=> 'devnet'),/Wrong network/);});
test('tampered binary refused',async()=>{const f=fixture();f.pd[46]^=1;f.accounts[1]=acc(f.pd,LOADER);await assert.rejects(()=>verifyReleaseSnapshot(f.rpc,f.e),/binary changed/);});
test('slot or upgrade authority change refused',async()=>{const f=fixture();f.pd.writeBigUInt64LE(474265506n,4);f.accounts[1]=acc(f.pd,LOADER);await assert.rejects(()=>verifyReleaseSnapshot(f.rpc,f.e),/slot or authority/);f.pd.writeBigUInt64LE(474265505n,4);f.pd.set(publicKey(key(4)),13);f.accounts[1]=acc(f.pd,LOADER);await assert.rejects(()=>verifyReleaseSnapshot(f.rpc,f.e),/slot or authority/);});
test('wrong loader and ProgramData pointer refused',async()=>{const f=fixture();f.accounts[0]=acc(f.p,key(3),true);await assert.rejects(()=>verifyReleaseSnapshot(f.rpc,f.e),/owner/);f.p.set(publicKey(key(3)),4);f.accounts[0]=acc(f.p,LOADER,true);await assert.rejects(()=>verifyReleaseSnapshot(f.rpc,f.e),/pointer/);});
test('unknown or active protocol state is not accepted as locked',async()=>{const f=fixture();f.accounts[2]=acc(config(1));await assert.rejects(()=>verifyReleaseSnapshot(f.rpc,f.e),/Unexpected protocol mode/);f.accounts[2]=acc(config(255));await assert.rejects(()=>verifyReleaseSnapshot(f.rpc,f.e),/Unknown protocol mode/);f.accounts[2]=acc(config());assert.equal((await verifyReleaseSnapshot(f.rpc,f.e)).protocol.mode,'locked');});
test('stale finalized context refused',async()=>{const f=fixture();await assert.rejects(()=>verifyReleaseSnapshot(async(m)=>m==='getGenesisHash'?D.genesis:frame(f.accounts,1),f.e),/stale/);});
test('strict protocol layout and discriminator checks',()=>{assert.equal(decodeProtocol(null),null);assert.equal(decodeProtocol(acc(config())).admin,key(1));const b=config();b[0]^=1;assert.throws(()=>decodeProtocol(acc(b)),/schema/);assert.throws(()=>decodeProtocol(acc(Buffer.alloc(106))),/schema/);});
test('public market parsing preserves u64 beyond safe JS numbers',()=>{const x=decodeMarket(key(9),acc(market()));assert.equal(x.baseReserve,'9007199254740999');assert.equal(x.creator,key(1));assert.equal(x.quoteMint,key(3));assert.equal(x.phase,'pool');assert.equal(x.version,'7');assert.equal(x.name,'Test market');assert.equal(x.feeBps,30);assert.equal(x.metadataUri,'https://example.com/test');});
test('market decoding rejects substituted owner, bad schema and oversized metadata',()=>{const b=market();assert.throws(()=>decodeMarket(key(9),acc(b,key(4))),/owner/);b[8]=2;assert.throws(()=>decodeMarket(key(9),acc(b)),/schema/);b[8]=1;b.writeUInt32LE(999,309);assert.throws(()=>decodeMarket(key(9),acc(b)),/metadata length/);});
test('market discovery uses exact owner program, size, discriminator and finalized context',async()=>{const x=await discoverMarkets(async(m,p)=>{if(m==='getGenesisHash')return D.genesis;assert.equal(m,'getProgramAccounts');assert.equal(p[0],D.programId);assert.equal(p[1].filters[0].dataSize,MARKET_BYTES);assert.equal(p[1].filters[1].memcmp.bytes,base58(tag('account:Market')));assert.equal(p[1].withContext,true);return frame([{pubkey:key(9),account:acc(market())}]);});assert.equal(x.markets.length,1);assert.equal(x.source,'finalized-rpc-scan');});
test('empty scan distinct from RPC rejection and duplicate accounts',async()=>{assert.deepEqual((await discoverMarkets(async m=>m==='getGenesisHash'?D.genesis:frame([]))).markets,[]);await assert.rejects(()=>discoverMarkets(async m=>{if(m==='getGenesisHash')return D.genesis;throw new Error('scan refused');}),/scan refused/);await assert.rejects(()=>discoverMarkets(async m=>m==='getGenesisHash'?D.genesis:frame([1,2].map(()=>({pubkey:key(9),account:acc(market())})))),/duplicate/);});
test('single market lookup reports absent and refuses wrong chain',async()=>{assert.equal((await lookupMarket(async m=>m==='getGenesisHash'?D.genesis:frame(null),key(9))).market,null);await assert.rejects(()=>lookupMarket(async()=> 'devnet',key(9)),/Wrong network/);});
test('RPC transport refuses mutating method, and never performs fetch',async()=>{let count=0;const rpc=createReadRpc('https://example.com/rpc',async()=>{count++;throw Error('must not fetch');});await assert.rejects(()=>rpc('sendTransaction',[]),/refused/);assert.equal(count,0);assert.throws(()=>createReadRpc('http://example.com/rpc'),/HTTPS/);});
test('RPC transport validates response id and reports RPC error',async()=>{const good=createReadRpc('https://example.com',async(_url,req)=>{const b=JSON.parse(req.body);assert.equal(b.method,'getGenesisHash');assert.equal(req.redirect,'error');return new Response(JSON.stringify({jsonrpc:'2.0',id:b.id,result:D.genesis}));});assert.equal(await good('getGenesisHash'),D.genesis);const bad=createReadRpc('https://example.com',async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:99,error:{code:-1}})));await assert.rejects(()=>bad('getGenesisHash'),/invalid response/);});
test('public activity is bounded to ten finalized signatures and failure flags',async()=>{const r=await recentActivity(async(m,p)=>{if(m==='getGenesisHash')return D.genesis;assert.deepEqual(p,[D.programId,{limit:10,commitment:'finalized'}]);return [{signature:D.signature,slot:474265505,err:null}];});assert.deepEqual(r,[{signature:D.signature,slot:474265505,failed:false}]);await assert.rejects(()=>recentActivity(async m=>m==='getGenesisHash'?D.genesis:Array(11).fill({})),/Invalid history/);});
const ctx={rpcUrl:'http://127.0.0.1:8899',programId:key(20)};
const a=Object.fromEntries(['creator','market','baseMint','quoteMint','lpMint','baseVault','quoteVault','lpLock','protocol','trader','userBase','userQuote','userLp'].map((v,i)=>[v,key(i+1)]));
const v={buy:true,amountIn:10n,minimumOut:1n,version:7n,deadlineSlot:100n};
test('local-only swap descriptor matches Anchor discriminator and exact account order',()=>{const x=ix.previewSwap(ctx,a,v);const data=Buffer.from(x.dataHex,'hex');assert.deepEqual(data.subarray(0,8),tag('global:swap'));assert.equal(data[8],1);assert.equal(data.readBigUInt64LE(9),10n);assert.equal(data.readBigUInt64LE(33),100n);assert.equal(x.keys[0].pubkey,a.trader);assert.equal(x.keys[0].isSigner,true);assert.equal(x.keys[9].pubkey,a.protocol);assert.equal(x.purpose,'loopback-public-test-only');});
test('create, graduate and LP descriptors bind tags, signer and protocol account',()=>{const cases=[['create_market',ix.previewCreate(ctx,a,{nonce:1n,name:'Test',symbol:'TST',metadataUri:'',supply:10000n,virtualQuote:1000n,graduationQuote:2000n,feeBps:30}),12],['graduate',ix.previewGraduate(ctx,a,v),9],['add_liquidity',ix.previewAddLiquidity(ctx,a,{maxBase:2n,maxQuote:3n,minShares:1n,...v}),13],['remove_liquidity',ix.previewRemoveLiquidity(ctx,a,{shares:2n,minBase:1n,minQuote:1n,...v}),13]];for(const [name,x,n] of cases){assert.deepEqual(Buffer.from(x.dataHex,'hex').subarray(0,8),tag('global:'+name));assert.equal(x.keys.length,n);assert.equal(x.keys.at(-1).pubkey,a.protocol);}});
test('local descriptor rejects mainnet target, remote URL and invalid integer inputs',()=>{assert.throws(()=>ix.previewSwap({...ctx,programId:D.programId},a,v),/loopback/);assert.throws(()=>ix.previewSwap({...ctx,rpcUrl:'https://api.mainnet-beta.solana.com'},a,v),/loopback/);assert.throws(()=>ix.previewSwap(ctx,a,{...v,amountIn:0n}),/positive u64/);assert.throws(()=>ix.previewSwap(ctx,a,{...v,amountIn:1n<<64n}),/positive u64/);});
