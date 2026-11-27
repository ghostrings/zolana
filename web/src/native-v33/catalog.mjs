import {PublicKey} from '@solana/web3.js';
import {readNativeSnapshot,readConnection,readMarketMetadata} from './browser-ui.mjs';
import {readNativeAsset} from '../../../shared/src/native-asset.ts';
import {V33} from '../../../shared/src/ghost-markets/v33-release.ts';
import {readRecentMarketHistory} from './market-history.mjs';
import {marketMetrics} from './launch-policy.mjs';
import {marketProfile,OPEN} from './market-profile.mjs';
import {recentTradeStats,nativeMatches} from './catalog-data.mjs';
let cached=null,inflight=null,until=0;
const detailCache=new Map();
function bounded(p,ms=10000){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Catalog read timed out')),ms);})]).finally(()=>clearTimeout(timer));}
export async function nativeCatalog(){
 if(Date.now()<until)return cached;if(inflight)return inflight;
 inflight=(async()=>{try{const d=await readNativeSnapshot(10000);cached={markets:d.markets.markets,slot:d.markets.slot,releaseSlot:Number(d.observation.deploymentSlot)};until=Date.now()+45000;return cached;}catch{cached=null;until=Date.now()+15000;return null;}finally{inflight=null;}})();return inflight;
}
export function matchingNative(snapshot,view){
 return (snapshot?.markets??[]).filter(m=>nativeMatches(m,view.query,view.pair)).sort((a,b)=>view.sort==='graduation'?marketMetrics(b).progress-marketMetrics(a).progress||a.address.localeCompare(b.address):view.sort==='cap'?Number(marketMetrics(b).price)*Number(BigInt(b.initialSupply)-BigInt(b.burned))-Number(marketMetrics(a).price)*Number(BigInt(a.initialSupply)-BigInt(a.burned))||a.address.localeCompare(b.address):a.address.localeCompare(b.address));
}
async function detail(m,snapshot){
 const cacheKey=m.address+':'+m.version+':'+snapshot.releaseSlot;
 const old=detailCache.get(cacheKey);if(old&&old.until>Date.now())return old.promise;
 const promise=(async()=>{
 const {c}=readConnection();const [meta,asset,hist,supply]=await Promise.allSettled([bounded(readMarketMetadata(m)),bounded(readNativeAsset(c,m.baseMint,snapshot.slot)),bounded(readRecentMarketHistory({connection:c,market:new PublicKey(m.address),program:V33.programId,releaseSlot:marketProfile(m)===OPEN?snapshot.releaseSlot:474345522,minContextSlot:snapshot.slot})),bounded(c.getTokenSupply(new PublicKey(m.baseMint),'finalized'))]);
 const history=hist.status==='fulfilled'?hist.value:null,stats=recentTradeStats(history);const sv=supply.status==='fulfilled'?supply.value:null;const tokenSupply=sv&&sv.context?.slot>=snapshot.slot&&sv.value?.decimals===6&&typeof sv.value.amount==='string'&&/^\d{1,20}$/.test(sv.value.amount)&&BigInt(sv.value.amount)<=BigInt(m.initialSupply)?sv.value.amount:null;
 return {image:meta.status==='fulfilled'?meta.value.image:'',registered:asset.status==='fulfilled'&&asset.value.state==='registered'&&asset.value.slot>=snapshot.slot,assetId:asset.status==='fulfilled'?asset.value.assetId:null,history,stats,supply:tokenSupply};
 })();detailCache.set(cacheKey,{promise,until:Date.now()+60000});if(detailCache.size>100)detailCache.delete(detailCache.keys().next().value);return promise;
}
export async function catalogToken(m,snapshot){
 const d=await detail(m,snapshot),metric=marketMetrics(m),p=Number(metric.price),cap=d.supply!==null&&Number.isFinite(p)&&p>0?String(p*Number(d.supply)/1e6):'';
 return {mint:m.baseMint,pool:m.address,feeBps:m.feeBps,creator:m.creator,modules:null,name:m.name,symbol:m.symbol,description:'',image:d.image,website:'',twitter:'',stage:m.phase==='pool'?'graduated':m.phase==='ready'?'migrating':'curve',pair:{id:'SOL',symbol:'SOL',mint:V33.quoteMint,decimals:9},price:metric.price,marketCap:cap,progress:metric.progress/100,reserve:m.quoteReserve,threshold:m.graduationQuote,fees:'',volume:'',volume24h:'',supply:d.supply??'',burned:d.supply===null?'0':String(BigInt(m.initialSupply)-BigInt(d.supply)),createdAt:d.stats.createdAt,spark:d.stats.points.length>=2?d.stats.points.map(p=>p.price):[],change24h:null,native:{market:m.address,registered:d.registered,assetId:d.assetId,recentVolume:d.history?d.stats.volume:null,recentCount:d.history?d.stats.count:null,incomplete:d.stats.incomplete,capKnown:cap!==''}};
}
// Keep network requests bounded. Only enrich the native cards actually visible in the current page.
export async function catalogTokens(markets,snapshot){const result=[];for(let i=0;i<markets.length;i+=3)result.push(...await Promise.all(markets.slice(i,i+3).map(m=>catalogToken(m,snapshot))));return result;}
