/** Proposed immutable parameters. Market-cap target uses original issued supply, before burn. */
export const V41_PROFILE = Object.freeze({supply:'1000000000000',virtualQuote:'3500000000',graduationQuote:'12040270268',quoteCap:'25000000000',nominalGraduationCap:'69000000000'});
export const LEGACY_PROFILE = Object.freeze({supply:'1000000000000',virtualQuote:'100000000',graduationQuote:'200000000',quoteCap:'1000000000'});
export function profileFor(supply:string,virtualQuote:string,graduationQuote:string) {
  if (supply!==LEGACY_PROFILE.supply) return null;
  if (virtualQuote===LEGACY_PROFILE.virtualQuote&&graduationQuote===LEGACY_PROFILE.graduationQuote) return LEGACY_PROFILE;
  if (virtualQuote===V41_PROFILE.virtualQuote&&graduationQuote===V41_PROFILE.graduationQuote) return V41_PROFILE;
  return null;
}
