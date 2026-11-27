/** Shared pure launch policy. Metadata is a public URI, never HTML or an arbitrary fetch target. */
export const LIVE_DEPLOYMENT_SLOT='474345522';
export function checkedMetadataUri(value,allowEmpty=false){
 if(allowEmpty&&value==='')return '';
 if(typeof value!=='string'||new TextEncoder().encode(value).length>200||/[\x00-\x20\x7f]/.test(value))throw Error('Invalid public metadata URI');
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.search||url.href!==value)throw Error('Use a canonical HTTPS metadata URI');
 const cid='(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,100})';
 if(url.origin==='https://privacycash.fun'&&/^\/api\/metadata\/[a-f0-9]{32}\.json$/.test(url.pathname))return value;
 if(new RegExp('^/ipfs/'+cid+'$').test(url.pathname))return value;
 throw Error('Metadata must be a privacycash.fun upload or an IPFS gateway CID');
}
export function canonicalUploadedMetadataUri(value){
 const uri=checkedMetadataUri(value),u=new URL(uri);
 return checkedMetadataUri("https://privacycash.fun"+u.pathname);
}
export function metadataReadPath(value){
 try { const uri=checkedMetadataUri(value),u=new URL(uri);return u.pathname.startsWith('/ipfs/')?u.pathname:u.origin==='https://privacycash.fun'?u.pathname:null; }catch{return null;}
}
/** The owner exception is exactly the existing V35 single empty-market pilot, not an audit. */
export function firstPilotAllowed(observation,scan,V33){
 return observation?.release==='v33'&&observation.source==='finalized-rpc'&&observation.deploymentSlot===LIVE_DEPLOYMENT_SLOT&&observation.binarySha256===V33.binarySha256&&observation.protocolInitialized===true&&observation.privateSettlement===false&&observation.config?.mode==='active'&&observation.config.admin===V33.admin&&observation.config.pauser===V33.pauser&&observation.config.treasury===V33.treasury&&observation.config.pendingAdmin==='11111111111111111111111111111111'&&Number.isSafeInteger(scan?.slot)&&scan.slot>=observation.slot&&Array.isArray(scan.markets)&&scan.markets.length===0;
}
export function formatUnits(value,decimals){const s=BigInt(value).toString().padStart(decimals+1,'0');return `${s.slice(0,-decimals)}.${s.slice(-decimals)}`.replace(/0+$/,'').replace(/\.$/,'');}
export function marketMetrics(m){
 const b=BigInt(m.baseReserve),q=BigInt(m.quoteReserve),v=BigInt(m.virtualQuote),goal=BigInt(m.graduationQuote);
 if(b<=0n||q<0n||goal<=0n||!['curve','ready','pool'].includes(m.phase))throw Error('Invalid reserves');
 const effective=q+(m.phase==='pool'?0n:v);
 // Price in SOL per whole token, expressed in units of 10^-12 SOL.
 const scaled=effective*1_000_000_000n/b;
 const progress=m.phase==='pool'?10000n:(q*10000n/goal>10000n?10000n:q*10000n/goal);
 return {price:scaled===0n?'Below 0.000000000001':formatUnits(scaled,12),progress:Number(progress)/100,quote:formatUnits(q,9),base:formatUnits(b,6),creatorFees:formatUnits(m.creatorFees,9),platformFees:formatUnits(m.platformFees,9)};
}
