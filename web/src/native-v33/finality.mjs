/** Bounded read-only finality tracking; never re-sends or treats timeout as failure. */
export async function observeSignature(connection,signature,{timeoutMs=60_000,intervalMs=1500,clock=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(typeof signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))throw Error('Invalid signature');
 const until=clock()+timeoutMs;
 do {
  try {const s=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(s?.confirmationStatus==='finalized')return {status:s.err===null?'finalized':'finalized failure',slot:s.slot};}
  catch{/* network or provider unavailable; keep outcome unknown */}
  if(clock()>=until)break;await sleep(intervalMs);
 }while(clock()<until);
 return {status:'confirmation not established; inspect signature before retry',slot:null};
}
