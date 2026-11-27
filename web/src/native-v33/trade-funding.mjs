/** Integer-only balance checks for public native swaps. No signer or RPC access. */
export function tradeFundingEstimate({action,amountIn,solBalance,tokenBalance,missingAtaCount,ataRentLamports,feeLamports}) {
 const lamports=(n,label)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid '+label);return BigInt(n);};
 if(!['buy','sell'].includes(action)||typeof amountIn!=='bigint'||amountIn<=0n||amountIn>(1n<<64n)-1n||typeof tokenBalance!=='bigint'||tokenBalance<0n||!Number.isInteger(missingAtaCount)||missingAtaCount<0||missingAtaCount>2)throw Error('Invalid trade funding inputs');
 const sol=lamports(solBalance,'SOL balance'),rent=lamports(ataRentLamports,'token account rent')*BigInt(missingAtaCount),fee=lamports(feeLamports,'network fee');
 if(action==='sell'&&tokenBalance<amountIn)throw Error('Insufficient public token balance');
 const input=action==='buy'?amountIn:0n,required=input+rent+fee;
 if(sol<required)throw Error('Insufficient public SOL for trade input, account rent and network fee; shielded SOL is not spendable here');
 return {publicSolLamports:String(sol),publicTokenBaseUnits:String(tokenBalance),estimatedNewAtaRentLamports:String(rent),networkFeeLamports:String(fee),estimatedTotalSolDebitLamports:String(required),missingAtaCount};
}
