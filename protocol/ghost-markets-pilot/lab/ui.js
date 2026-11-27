'use strict';
const $=id=>document.getElementById(id),token=document.querySelector('meta[name=lab-token]').content;
let state=null,pending=null,busy=false,stopped=false;
const txt=(id,v)=>{$(id).textContent=v??'—';};
function invalidate(){pending=null;txt('quoted','No quote yet');controls();}
function controls(){for(const id of ['refresh','launch','getquote','confirm','pause','resume','stop','claim-platform','claim-creator'])$(id).disabled=busy||stopped; if(!busy&&!stopped){$('launch').disabled=!state||!!state.market||state.mode!==1||state.halted;$('getquote').disabled=!state?.market||state.halted;$('confirm').disabled=!pending||state?.halted;$('pause').disabled=state?.mode!==1||state?.halted;$('resume').disabled=state?.mode!==2||state?.halted;for(const role of ['platform','creator'])$('claim-'+role).disabled=!state?.fees||BigInt(state.fees[role])===0n||state.halted;}}
async function rpc(path,body){const r=await fetch(path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Ghost-Lab-Token':token},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw new Error(v.error||'Request failed');return v;}
function render(s){state=s;txt('mode',['Locked','Active','Paused'][s.mode]);txt('phase',s.market?['Curve','Ready to graduate','AMM pool'][s.market.phase]:'No market');txt('program',s.programId);txt('market',s.market?s.marketAddress:null);txt('mint',s.market?s.mint:null);txt('launchsig',s.launchSignature);txt('lastsig',s.lastSignature);txt('chain',JSON.stringify({network:s.network,name:s.name,symbol:s.symbol,market:s.market,lpSupply:s.lpSupply,lpLocked:s.lpLocked,baseSupply:s.baseSupply,feePolicy:{curve:"80% platform / 20% deployer",pool:"100% platform, all LP locked",asset:"WSOL"},accruedFeeLamports:s.fees,claimedFeeBalancesLamports:s.feeBalances,platform:s.platform,deployer:s.creator,traderBalancesBaseUnits:s.balances?{token:s.balances[0],wsol:s.balances[1],lp:s.balances[2]}:null,privateSettlement:false,halted:s.halted},null,2));}
async function run(fn){if(busy)return;busy=true;controls();try{txt('status','Processing local validator request…');await fn();txt('status',stopped?'Lab stopped. Close this tab.':state?.halted?'Lab halted. Restart with a fresh local ledger.':'Ready — local test network only.');}catch(e){invalidate();txt('status',e.message);try{render(await rpc('/state'));}catch{} }finally{busy=false;controls();}}
function request(){return {action:$('action').value,amount:$('amount').value,version:state?.market?.version};}
$('refresh').onclick=()=>run(async()=>{invalidate();render(await rpc('/state'));});
$('launch').onclick=()=>run(async()=>{if(!window.confirm('Create a public SPL token on the local test validator?'))return;invalidate();render(await rpc('/action',{action:'launch',name:$('name').value,symbol:$('symbol').value.toUpperCase(),feeBps:$('feeBps').value}));});
$('getquote').onclick=()=>run(async()=>{const b=request(),q=await rpc('/quote',b);pending={...b,approval:q.approval};txt('quoted',JSON.stringify(q.quote,null,2)+'\nAll amounts are base units. Exact quote expires in 60 seconds.');});
$('confirm').onclick=()=>run(async()=>{const b=pending;if(!b||!window.confirm('Submit this exact quoted local test transaction?'))return;invalidate();render(await rpc('/action',b));});
for(const op of ['pause','resume'])$(op).onclick=()=>run(async()=>{invalidate();render(await rpc('/action',{action:op}));});
$('symbol').addEventListener('input',()=>{$('symbol').value=$('symbol').value.toUpperCase();});
for(const id of ['action','amount'])$(id).addEventListener('input',invalidate);
for(const role of ['platform','creator'])$('claim-'+role).onclick=()=>run(async()=>{if(!window.confirm('Claim accrued '+role+' WSOL fees on the local validator?'))return;invalidate();render(await rpc('/action',{action:'claim-'+role}));});
$('stop').onclick=()=>run(async()=>{await rpc('/stop',{});stopped=true;});
controls();run(async()=>render(await rpc('/state')));
