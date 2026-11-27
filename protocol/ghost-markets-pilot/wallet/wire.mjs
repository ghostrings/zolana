/** Validate the legacy Solana wire signing boundary using WebCrypto, without wallet secrets.
 * The original transaction must already have been constructed and displayed by trusted code.
 * This verifies the handoff, not instruction safety for arbitrary imported transactions.
 */
export const sameBytes=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const empty=b=>b.every(v=>v===0);
function parse(wire){
 if(!(wire instanceof Uint8Array)||wire.length>1232||wire.length<102)throw new Error('Invalid transaction wire');
 // Under the 1232-byte packet bound both signer and account counts fit in one shortvec byte.
 const n=wire[0],start=1+64*n,m=wire.subarray(start);
 if(n<1||n>18||m.length<4||m[0]!==n||m[1]>=n||m[2]>127||m[3]<n||m[3]>38||m.length<4+32*m[3]+33||m[2]>m[3]-n)throw new Error('Expected canonical legacy signer header');
 const signers=Array.from({length:n},(_,i)=>m.subarray(4+32*i,36+32*i));
 if(signers.some((x,i)=>signers.slice(0,i).some(y=>sameBytes(x,y))))throw new Error('Duplicate signer');
 return {n,m,signers,signatures:Array.from({length:n},(_,i)=>wire.subarray(1+64*i,65+64*i))};
}
async function verify(pubkey,message,signature){
 const k=await crypto.subtle.importKey('raw',Uint8Array.from(pubkey),{name:'Ed25519'},false,['verify']);
 return crypto.subtle.verify('Ed25519',k,Uint8Array.from(signature),Uint8Array.from(message));
}
export async function mergeWalletWire(original,returned,signer){
 if(!(signer instanceof Uint8Array)||signer.length!==32)throw new Error('Invalid selected signer');
 const a=parse(original),b=parse(returned);
 if(!sameBytes(a.m,b.m)||a.n!==b.n||returned.length!==original.length)throw new Error('Wallet changed the message');
 const i=a.signers.findIndex(s=>sameBytes(s,signer));
 if(i<0||!empty(a.signatures[i]))throw new Error('Unexpected signer');
 for(let j=0;j<a.n;j++){
   const before=a.signatures[j],after=b.signatures[j];
   if(j===i){if(empty(after))throw new Error('Wallet did not sign');}
   else if(!sameBytes(before,after))throw new Error('Other signer slot changed');
   if(!empty(after)&&!(await verify(a.signers[j],a.m,after)))throw new Error('Invalid signature');
 }
 return Uint8Array.from(returned);
}
