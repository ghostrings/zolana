/** V41 permissionless market parameters. All amounts are integer base units. */
export const PROFILE = Object.freeze({
  quoteMint:'So11111111111111111111111111111111111111112',
  baseDecimals:6, quoteDecimals:9,
  supply:1_000_000_000_000n,
  virtualQuote:3_500_000_000n,
  graduationQuote:12_040_270_268n,
  feeBps:300n,
  quoteCap:25_000_000_000n,
});
export function assertMetadata(name,symbol) {
  if(typeof name !== 'string' || !name.length || new TextEncoder().encode(name).length>32 || /\p{Cc}/u.test(name)) throw new Error('Name must be 1–32 UTF-8 bytes without control characters');
  if(typeof symbol !== 'string' || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('Symbol must be 1–10 uppercase letters or digits');
}
export function assertQuoteCap(next, owed=0n) {
  if(typeof next.quote!=='bigint'||next.quote<0n||typeof owed!=='bigint'||owed<0n||next.quote+owed>PROFILE.quoteCap) throw new Error('Pilot accounted quote cap exceeded');
}
