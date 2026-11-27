import { getWallets } from '@wallet-standard/app';
import { initShell, byId, setText } from '../ui.ts';
import { mountRuntime } from '../shell.ts';
import { V33, launchIntent, signingAllowed, reviewedRelease } from '../../../shared/src/ghost-markets/v33-release.ts';
import { publicKey, base58 } from '../../../shared/src/ghost-markets/observe.ts';
import { stagedV33Client } from '../native-v33/client.mjs';
import { Connection } from '@solana/web3.js';
import { readNativeAsset } from '../../../shared/src/native-asset.ts';
import { nativeAssetMessage } from '../../../shared/src/ghost-markets/asset-state.ts';
import '../native-markets.css';
initShell('create');void mountRuntime();
const el=id=>byId(`v33-${id}`), text=(id,s)=>setText(`v33-${id}`,String(s));
let wallets=[], wallet=null, account=null, intent=null, handle=null, signed=[], client=null, observation=null, markets=[], busy=false, sent=false;
const json=x=>JSON.stringify(x,null,2);
const validWallets=()=>getWallets().get().filter(w=>w.chains?.includes('solana:mainnet')&&typeof w.features?.['standard:connect']?.connect==='function');
function option(select,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}
function chooseWallets(){wallets=validWallets();el('wallet').replaceChildren();option(el('wallet'),'','Select wallet');wallets.forEach((w,i)=>option(el('wallet'),String(i),w.name));}
function message(s){text('message',s);}
function selected(){return wallet&&account&&wallet.accounts.includes(account)&&account.chains.includes('solana:mainnet')&&base58(account.publicKey)===account.address;}
function gate(action){return !busy&&!sent&&reviewedRelease()!==null&&!!observation&&signingAllowed(observation,action);}
function controls(){
 const ok=selected();el('draft-launch').disabled=!(ok&&gate('launch')&&intent&&intent.creator===account.address);
 el('draft-action').disabled=!(ok&&gate(el('action').value)&&el('market').value);
 el('export').disabled=!intent||busy;
 el('sign').disabled=!(handle&&ok&&gate(handle.summary.action)&&el('risk').checked&&handle.summary.signers.includes(account.address)&&!signed.includes(account.address));
 el('send').disabled=!(handle&&gate(handle.summary.action)&&el('risk').checked&&handle.summary.signers.every(s=>signed.includes(s)));
 el('init').disabled=!(ok&&gate('initialize')&&[V33.treasury,V33.upgradeAuthority].includes(account.address));
 el('export-approval').disabled=!(handle&&gate(handle.summary.action)&&['launch','initialize'].includes(handle.summary.action));
 el('import-approval').disabled=busy||sent||!reviewedRelease()||!observation||!(gate('launch')||gate('initialize'));
 el('refresh').disabled=busy;el('connect').disabled=busy;el('wallet-refresh').disabled=busy;el('account').disabled=busy;el('clear').disabled=busy;
}
function renderDraft(){text('draft',handle?json({review:handle.summary,signaturesCollected:signed,network:'mainnet-beta',warning:'Public SPL settlement; network fees and ATA rent may apply.'}):'No transaction prepared.');controls();}
function invalidateIntent(){intent=null;text('intent','No unsigned intent prepared.');controls();}
function discard(){handle=null;signed=[];sent=false;el('risk').checked=false;renderDraft();}
async function task(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){message(String(e?.message??'Request refused').slice(0,220));}finally{busy=false;controls();}}
function acceptAccount(a){publicKey(a.address);if(!a.chains.includes('solana:mainnet')||base58(a.publicKey)!==a.address)throw Error('Wrong wallet account');account=a;text('connected',`Selected public account: ${a.address}`);invalidateIntent();controls();}
el('wallet-refresh').addEventListener('click',chooseWallets);
el('connect').addEventListener('click',()=>void task(async()=>{
 const idx=el('wallet').value;if(idx==='')throw Error('Choose a wallet');const w=wallets[Number(idx)];if(!w||!validWallets().includes(w))throw Error('Wallet no longer available');
 await w.features['standard:connect'].connect();wallet=w;account=null;
 const available=w.accounts.filter(a=>a.chains.includes('solana:mainnet')&&base58(a.publicKey)===a.address);
 el('account').replaceChildren();option(el('account'),'','Select account');available.forEach(a=>option(el('account'),a.address,a.address));
 if(available.length===1){el('account').value=available[0].address;acceptAccount(available[0]);}else{text('connected','Select one connected account.');invalidateIntent();}
}));
el('account').addEventListener('change',()=>{try{const a=wallet?.accounts.find(a=>a.address===el('account').value);if(!a){account=null;text('connected','No native wallet selected.');invalidateIntent();}else acceptAccount(a);}catch(e){account=null;invalidateIntent();message(e.message);}controls();});
getWallets().on('register',()=>{if(!busy)chooseWallets();});
getWallets().on('unregister',()=>{if(!validWallets().includes(wallet)){wallet=null;account=null;invalidateIntent();}if(!busy)chooseWallets();});chooseWallets();
function coin(value,decimals){const raw=BigInt(value).toString().padStart(decimals+1,'0');return `${raw.slice(0,-decimals)}.${raw.slice(-decimals)}`;}
function split(){const fee=Number(el('tier').value)/100;text('split',`Platform ${(fee*.8).toFixed(1)}% · creator ${(fee*.2).toFixed(1)}%`);invalidateIntent();}
el('tier').addEventListener('change',split);el('name').addEventListener('input',invalidateIntent);el('symbol').addEventListener('input',invalidateIntent);el('risk').addEventListener('change',controls);el('market').addEventListener('change',controls);el('action').addEventListener('change',controls);
function currentIntent(){if(!selected())throw Error('Select your creator wallet first');return launchIntent(account.address,el('name').value.trim(),el('symbol').value.trim().toUpperCase(),Number(el('tier').value));}
el('launch-form').addEventListener('submit',e=>{e.preventDefault();try{intent=currentIntent();text('intent',json(intent));message('Unsigned intent only. No transaction or signature was generated.');}catch(e){invalidateIntent();message(e.message);}controls();});
el('export').addEventListener('click',()=>{if(!intent)return;const url=URL.createObjectURL(new Blob([json(intent)+'\n'],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ghost-unsigned-launch-intent.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
function makeClient(){client??=stagedV33Client();return client;}
el('draft-launch').addEventListener('click',()=>void task(async()=>{if(!selected()||!intent||json(intent)!==json(currentIntent()))throw Error('Review the current intent first');discard();const nonce=crypto.getRandomValues(new BigUint64Array(1))[0];handle=await makeClient().launch({...intent,nonce});renderDraft();}));
el('draft-action').addEventListener('click',()=>void task(async()=>{if(!selected())throw Error('Choose wallet');const m=markets.find(m=>m.address===el('market').value);if(!m)throw Error('Select a current market snapshot');discard();const action=el('action').value,params={wallet:account.address,market:m.address};const c=makeClient();handle=action==='claim'?await c.claim(params):action==='graduate'?await c.graduation(params):await c.trade({...params,action,amount:el('amount').value,version:m.version});renderDraft();}));
el('sign').addEventListener('click',()=>void task(async()=>{if(!handle||!selected()||!el('risk').checked)throw Error('Review required');if(!confirm('Approve this exact public transaction message with the selected wallet?'))return;signed=await makeClient().sign(handle,wallet,account);renderDraft();}));
el('send').addEventListener('click',()=>void task(async()=>{if(!handle||!el('risk').checked)throw Error('Review required');const receipt=await makeClient().submit(handle,signature=>{text('receipt',`Expected signature: ${signature}`);return confirm(`Submit this fully signed public mainnet transaction?\nExpected signature: ${signature}`);});sent=true;text('receipt',json(receipt));message('Check the expected signature on Solana Explorer. Do not automatically resubmit.');}));
el('init').addEventListener('click',()=>void task(async()=>{if(!selected()||![V33.treasury,V33.upgradeAuthority].includes(account.address))throw Error('Select an initialization signer');discard();handle=await makeClient().initialization();renderDraft();}));
el('export-approval').addEventListener('click',()=>void task(async()=>{if(!handle)throw Error('No approval draft');const data=await makeClient().exportApproval(handle),url=URL.createObjectURL(new Blob([json(data)+'\n'],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ghost-v33-pending-approval.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('Share only with the intended co-signer. Expires with the blockhash.');}));
el('import-approval').addEventListener('change',()=>void task(async()=>{const f=el('import-approval').files?.[0];el('import-approval').value='';if(!f||f.size>10000)throw Error('Invalid approval file');const data=await makeClient().importApproval(JSON.parse(await f.text()),handle);handle=data.handle;signed=data.signed;el('risk').checked=false;renderDraft();message('Canonical approval checked. Review before signing or sending.');}));
el('clear').addEventListener('click',discard);
async function refresh(){
 observation=null;markets=[];controls();text('status','Reading finalized mainnet accounts…');text('version','Unknown');text('mode','Unknown');text('gate','Disabled');el('market-list').replaceChildren();el('market').replaceChildren();option(el('market'),'','Choose market');
 try{
  const res=await fetch('/api/ghost-markets/v33/status',{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(120_000)});if(!res.ok)throw Error('Read failed');const data=await res.json(),o=data.observation;
  if(o?.release==='v41'){message('V41 launches use /create?rail=native. Historical approval workspace is disabled.');throw Error('Use the native launch form at /create?rail=native.');}
  if(data.verification!=='matched'||data.privateSettlement!==false||!o||o.privateSettlement!==false||!['v27-locked','v33'].includes(o.release))throw Error('Release not verified');
  if(o.release==='v33'&&o.binarySha256!==V33.binarySha256)throw Error('Unexpected executable');
  observation=o;text('version',o.release==='v33'?'V33 deployed bytes match':'V27 locked bytes match');text('mode',o.protocolInitialized?(o.config?.mode??'Locked V27'):'Not initialized');text('gate',signingAllowed(o,'sell')?'Public market checkout on token pages':'Disabled for deployment/state');text('status',`Finalized slot ${o.slot}. Native settlement is public; native token checkout is ${signingAllowed(o,'sell')?'owner-authorized, unaudited':'disabled'}.`);
  if(data.markets===null){text('markets-note','No V33 market snapshot available. This is not a claim of zero markets.');return;}
  if(!Array.isArray(data.markets.markets))throw Error('Bad market snapshot');markets=data.markets.markets;text('markets-note',`${markets.length} market(s) observed at finalized slot ${data.markets.slot}. Public balances; not audited private holdings.`);
  for(const m of markets){const item=document.createElement('article');item.className='panel';const h=document.createElement('h3');h.textContent=`${m.symbol} · ${m.name}`;item.append(h);for(const line of [`Phase ${m.phase} · fee ${m.feeBps/100}%`, `Quote principal ${coin(m.quoteReserve,9)} SOL`, `Platform owed ${coin(m.platformFees,9)} WSOL · Creator owed ${coin(m.creatorFees,9)} WSOL`, `Locked LP base units ${m.lockedLp}`, `Creator ${m.creator}`, `Mint ${m.baseMint}`]){const p=document.createElement('p');p.textContent=line;item.append(p);}const link=document.createElement('a');publicKey(m.address);link.href=`https://explorer.solana.com/address/${m.address}`;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Market explorer';item.append(link);const tradeLink=document.createElement('a');tradeLink.className='btn secondary';tradeLink.href='/native-token?market='+encodeURIComponent(m.address);tradeLink.textContent='Open native market';item.append(tradeLink);const assetLine=document.createElement('p');assetLine.className='tiny dim';assetLine.textContent='Default Ring interface not checked.';item.append(assetLine);const check=document.createElement('button');check.type='button';check.className='btn secondary';check.textContent='Check encrypted holdings support';item.append(check);const walletLink=document.createElement('a');walletLink.className='btn secondary';walletLink.href='/wallet';walletLink.textContent='Open wallet';walletLink.hidden=true;item.append(walletLink);check.addEventListener('click',async()=>{check.disabled=true;walletLink.hidden=true;assetLine.textContent='Checking finalized mint and Privacy Rings registry…';try{const c=new Connection(`${location.origin}/api/helius`,'finalized');const a=await readNativeAsset(c,m.baseMint,data.markets.slot);assetLine.textContent=`${nativeAssetMessage(a.state)} (slot ${a.slot})`;walletLink.hidden=a.state!=='registered';}catch{assetLine.textContent=nativeAssetMessage('unavailable');}finally{check.disabled=false;}});el('market-list').append(item);option(el('market'),m.address,`${m.symbol} — ${m.address.slice(0,8)}…`);}
 }catch{observation=null;markets=[];text('status','Current release verification unavailable. Native signing remains disabled.');text('markets-note','Snapshot unavailable.');el('market-list').replaceChildren();el('market').replaceChildren();option(el('market'),'','Choose market');}finally{controls();}
}
el('refresh').addEventListener('click',()=>void task(refresh));void task(refresh);controls();
