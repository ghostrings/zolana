/** Decode the read-only status API for display. Never grants signing authority. */
import { DEPLOYMENT } from './observe.js';
import { V33, isKnownNativeRelease, signingAllowed, type NativeObservation } from './v33-release.js';
export type DisplayStatus = { observation:NativeObservation; marketCount:number|null };
export function parseNativeDisplay(raw:unknown):DisplayStatus|null {
  try {
    const r=raw as {verification?:unknown;privateSettlement?:unknown;observation?:NativeObservation;markets?:{slot:number;markets:unknown[]}|null};
    const o=r?.observation;
    if(r?.verification!=='matched'||r.privateSettlement!==false||!o||o.source!=='finalized-rpc'||o.privateSettlement!==false||!Number.isSafeInteger(o.slot)||o.slot<0||typeof o.deploymentSlot!=='string'||!/^\d+$/.test(o.deploymentSlot)||BigInt(o.deploymentSlot)>BigInt(o.slot)||typeof o.protocolInitialized!=='boolean')return null;
    if(o.release==='v27-locked'){
      if(o.binarySha256!==DEPLOYMENT.binarySha256||o.deploymentSlot!==DEPLOYMENT.deploymentSlot||o.config!==null)return null;
    }else if(o.release==='v33'||o.release==='v41'){
      if((o.release==='v33'?o.binarySha256!==V33.binarySha256:!isKnownNativeRelease(o))||BigInt(o.deploymentSlot)<=BigInt(DEPLOYMENT.deploymentSlot)||o.config===undefined||o.protocolInitialized!==(o.config!==null))return null;
      if(o.config&&(!['active','locked','paused'].includes(o.config.mode)||o.config.admin!==V33.admin||o.config.treasury!==V33.treasury||o.config.pauser!==V33.pauser||o.config.pendingAdmin!=='11111111111111111111111111111111'))return null;
    }else return null;
    const m=r.markets;
    const marketCount=(o.release==='v33'||o.release==='v41')&&o.config&&m&&Array.isArray(m.markets)&&m.markets.length<=500&&Number.isSafeInteger(m.slot)&&m.slot>=o.slot?m.markets.length:null;
    return {observation:o,marketCount};
  }catch{return null;}
}
export function nativeDisplaySummary(state:DisplayStatus|null):string {
  if(!state)return 'Current deployment verification unavailable. Native website signing remains disabled; no live market state is inferred.';
  const o=state.observation, label=o.release==='v41'?'V41':o.release==='v33'?'V33':'V27', mode=o.config?.mode??(o.protocolInitialized?'locked':'not initialized');
  const enabled=signingAllowed(o,'buy')?'Owner-authorized unaudited trading enabled.':signingAllowed(o,'sell')?'Owner-authorized unaudited exits and fee operations only; buys paused.':'Native website signing remains disabled for this deployment/state.';
  return `${label} executable matched at finalized slot ${o.slot.toLocaleString('en-US')}. Protocol: ${mode}. ${enabled} Settlement is public, not private.`;
}
