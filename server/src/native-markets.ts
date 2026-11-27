/** A read-only public status endpoint for the locked, deployed GHOST Markets program. */
import express from 'express';
import { createReadRpc, type RpcRead } from '../../shared/src/ghost-markets/observe.js';
import { inspectNativeRelease, scanV33, signingAllowed, V41_CANDIDATE, V41_EXTENSION_CAPACITY, v41OwnerRelease } from '../../shared/src/ghost-markets/v33-release.js';
import { createNativeStatusReader } from '../../shared/src/ghost-markets/status.js';
import { asyncRoute, clientIp, type RateLimiter, sendError } from './http.js';

export function nativeMarketsRouter(rpcUrl: string | undefined, limiter: RateLimiter) {
  // The operator's existing RPC configuration is the only upstream. Never forward user-supplied
  // endpoints, methods, account addresses, private keys, or transaction data.
  let rpc: RpcRead | undefined;
  try { if (rpcUrl) rpc = createReadRpc(rpcUrl); } catch { /* fail closed without disrupting the working launchpad */ }
  const read = createNativeStatusReader(rpc);
  const router = express.Router();
  router.get('/status', asyncRoute(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (!limiter.take(`native-markets:${clientIp(request)}`, 20, 60_000)) {
      return sendError(response, 429, 'RATE_LIMIT', 'Too many deployment status requests.');
    }
    const state = await read();
    response.json(state);
  }));
  // Separate staged V33 reader. Preserve the historical V27 endpoint and all write refusals.
  let inFlight: Promise<unknown> | undefined;
  let cache: {until:number; value:unknown}|undefined;
  async function snapshot() {
    if(!rpc) return {verification:'unavailable',observation:null,markets:null,signing:false,privateSettlement:false};
    if(cache&&cache.until>Date.now())return cache.value;
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      let value:unknown;
      try {
        const observation=await inspectNativeRelease(rpc!);
        // Do not scan V27 as schema 2. A provider failure is null, not an empty index.
        let markets:null|Awaited<ReturnType<typeof scanV33>>=null;
        if((observation.release==='v33'||observation.release==='v41')&&observation.config) {
          try { markets=await scanV33(rpc!); } catch { /* RPC refusal or changed deployment */ }
          // A separate scan can see a changed release; refresh the identity before returning it.
          const after=await inspectNativeRelease(rpc!);
          if(after.deploymentSlot!==observation.deploymentSlot||after.release!==observation.release||after.config?.mode!==observation.config.mode)throw Error('Release changed');
        }
        value={verification:'matched',observation,markets,signing:signingAllowed(observation,'sell'),v41Cutover:{binarySha256:V41_CANDIDATE.binarySha256,ownerAuthorized:v41OwnerRelease()!==null,extensionCapacityBytes:V41_EXTENSION_CAPACITY,independentReviewAsserted:false},privateSettlement:false};
      } catch { value={verification:'unavailable',observation:null,markets:null,signing:false,privateSettlement:false}; }
      cache={until:Date.now()+20_000,value};return value;
    })();
    try{return await inFlight;}finally{inFlight=undefined;}
  }
  router.get('/v33/status',asyncRoute(async(request,response)=>{
    response.setHeader('cache-control','no-store');
    if(!limiter.take(`native-v33:${clientIp(request)}`,10,60_000))return sendError(response,429,'RATE_LIMIT','Too many native status requests.');
    response.json(await snapshot());
  }));
  // Explicit refusal even if called directly: this integration has no native transaction route.
  router.use((_request, response) => {
    response.setHeader('cache-control', 'no-store');
    sendError(response, 405, 'NATIVE_MARKETS_READ_ONLY', 'This endpoint is read-only. Use the wallet-signed public market checkout; private settlement is not implemented.');
  });
  return router;
}
