/** A public native directory lookup, independent of the wallet's holdings. No private mint list is sent to it. */
import { isKnownNativeRelease, type MarketV33 } from '../../shared/src/ghost-markets/v33-release.js';
import { publicKey } from '../../shared/src/ghost-markets/observe.js';
type NativeIdentity=Pick<MarketV33,'address'|'baseMint'|'name'|'symbol'>;
let cached=new Map<string,NativeIdentity>(),until=0,inFlight:Promise<Map<string,NativeIdentity>>|null=null;
export async function nativeWalletDirectory():Promise<Map<string,NativeIdentity>> {
 if(Date.now()<until)return cached;
 if(inFlight)return inFlight;
 inFlight=(async()=>{try{const r=await fetch('/api/ghost-markets/v33/status',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Unavailable');const body=await r.json();if(body.verification!=='matched'||!body.observation||!isKnownNativeRelease(body.observation)||!Array.isArray(body.markets?.markets)||body.markets.markets.length>500)throw Error('Unavailable');const next=new Map<string,NativeIdentity>();for(const m of body.markets.markets){publicKey(m.address);publicKey(m.baseMint);if(typeof m.name!=='string'||typeof m.symbol!=='string'||!m.name.length||!/^[A-Z0-9]{1,10}$/.test(m.symbol))throw Error('Invalid native metadata');next.set(m.baseMint,{address:m.address,baseMint:m.baseMint,name:m.name,symbol:m.symbol});}cached=next;until=Date.now()+30000;return cached;}catch{until=Date.now()+30000;return cached;}})();try{return await inFlight;}finally{inFlight=null;}
}
