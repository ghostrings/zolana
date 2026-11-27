/** Optional Wallet Standard sign-only bridge for an explicitly selected local test account.
 * No discovery, connection, key custody, sending or mainnet chain selection.
 * Some wallet extensions do not advertise solana:localnet; refuse rather than lie about chain.
 */
export function localStandardSigner(wallet,account){
 const chain='solana:localnet';
 const feature=wallet?.features?.['solana:signTransaction'];
 if(!account?.chains?.includes(chain)||!account.features?.includes('solana:signTransaction')||!wallet.accounts?.includes(account)||!feature?.supportedTransactionVersions?.includes('legacy')||typeof feature.signTransaction!=='function')throw new Error('Selected wallet must explicitly support legacy localnet signing');
 return async wire=>{
   if(!wallet.accounts?.includes(account))throw new Error('Wallet account changed');
   const out=await feature.signTransaction({account,chain,transaction:Uint8Array.from(wire)});
   if(!Array.isArray(out)||out.length!==1||!(out[0].signedTransaction instanceof Uint8Array))throw new Error('Wallet did not return one signed transaction');
   return out[0].signedTransaction;
 };
}
