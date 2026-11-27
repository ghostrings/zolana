/** Display-only adapter. Never infers total lifetime volume or a 24h return from a bounded history. */
export function recentTradeStats(history){
 const rows=(history?.rows??[]).filter(r=>['buy','sell'].includes(r.kind));
 const sorted=[...rows].sort((a,b)=>a.slot-b.slot||Number(BigInt(a.version)-BigInt(b.version))||a.eventIndex-b.eventIndex);
 const points=sorted.map(r=>({price:Number(r.quoteLamports)/Number(r.tokenUnits)/1000,slot:r.slot,time:r.time})).filter(r=>Number.isFinite(r.price)&&r.price>0);
 const volume=sorted.reduce((n,r)=>n+BigInt(r.quoteLamports),0n);
 const launch=history?.rows?.find(r=>r.kind==='launch'&&r.time!==null);
 return {points,volume:String(volume),count:sorted.length,createdAt:launch?launch.time*1000:0,incomplete:!history||history.unavailable>0};
}
export function nativeMatches(m,query,pair){
 if(pair&&pair.toUpperCase()!=='SOL')return false;
 const q=query.trim().toLowerCase();return !q||m.name.toLowerCase().includes(q)||m.symbol.toLowerCase().includes(q)||m.baseMint.toLowerCase().startsWith(q)||m.address.toLowerCase().startsWith(q);
}
/** Stable group ordering: native markets first; legacy results maintain server ordering. */
export function catalogWindow(nativeCount,legacyCount,page,size){
 const total=nativeCount+legacyCount,pages=Math.max(1,Math.ceil(total/size)),current=Math.min(Math.max(1,page),pages),offset=(current-1)*size;
 const nativeStart=Math.min(offset,nativeCount),nativeEnd=Math.min(offset+size,nativeCount),legacyStart=Math.max(0,offset-nativeCount),legacyTake=Math.min(size-(nativeEnd-nativeStart),Math.max(0,legacyCount-legacyStart));
 return {total,pages,page:current,size,nativeStart,nativeEnd,legacyStart,legacyTake};
}
