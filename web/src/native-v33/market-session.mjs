/** Explicit read-only public wallet balances and transaction status helpers. */
import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,NATIVE_MINT,TOKEN_PROGRAM_ID,unpackAccount} from '@solana/spl-token';
export async function readPublicMarketBalances(c,ownerAddress,mintAddress,minContextSlot){
 const owner=new PublicKey(ownerAddress),mint=new PublicKey(mintAddress),base=getAssociatedTokenAddressSync(mint,owner),wsol=getAssociatedTokenAddressSync(NATIVE_MINT,owner);
 const r=await c.getMultipleAccountsInfoAndContext([owner,base,wsol],{commitment:'finalized',minContextSlot});
 if(r.context.slot<minContextSlot||!Array.isArray(r.value)||r.value.length!==3)throw Error('Public balance snapshot unavailable');
 const [sol,b,q]=r.value;
 const amount=(address,info,expectedMint)=>{if(!info)return 0n;const a=unpackAccount(address,info,TOKEN_PROGRAM_ID);if(!a.isInitialized||!a.owner.equals(owner)||!a.mint.equals(expectedMint)||a.isFrozen)throw Error('Unexpected public token account');return a.amount;};
 const lamports=sol?.lamports??0;if(!Number.isSafeInteger(lamports)||lamports<0)throw Error('Invalid SOL balance');
 return {owner:ownerAddress,slot:r.context.slot,sol:BigInt(lamports),tokens:amount(base,b,mint),wsol:amount(wsol,q,NATIVE_MINT)};
}
