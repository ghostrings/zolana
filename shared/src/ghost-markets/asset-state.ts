/** Pure classifier: distinguishes absence from failed verification. Public account facts only. */
export type NativeAssetState = 'registered'|'registration-available'|'registration-restricted'|'unavailable';
export interface AssetFacts { mintValid:boolean; registry:'valid'|'absent'|'invalid'; config:'open'|'restricted'|'unknown' }
export function nativeAssetState(f:AssetFacts):NativeAssetState {
  if(!f.mintValid || f.registry==='invalid')return 'unavailable';
  if(f.registry==='valid')return 'registered';
  return f.config==='open'?'registration-available':f.config==='restricted'?'registration-restricted':'unavailable';
}
export function nativeAssetMessage(state:NativeAssetState):string {
  switch(state){
    case 'registered':return 'Default Ring asset interface verified. Supported holders may shield separately using Wallet. Deposits, withdrawals and market trades remain public; Default Ring transfers expose counterparties.';
    case 'registration-available':return 'No Default Ring asset interface yet. Current protocol permits interface creation. Registration is a separate public transaction; no encrypted holding is claimed.';
    case 'registration-restricted':return 'No Default Ring asset interface yet. Current protocol restricts its creation. Obtain authorized registration before shielding.';
    default:return 'Default Ring asset readiness unavailable. Do not infer registration, balance privacy or authorization.';
  }
}
