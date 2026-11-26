/** Public-SPL instruction descriptors for isolated local testing only. No signing or submission. */
import { DEPLOYMENT, publicKey, positiveU64 } from './observe.js';
export type LocalContext = Readonly<{ rpcUrl:string; programId:string }>;
export type AccountMeta = Readonly<{ pubkey:string; isWritable:boolean; isSigner:boolean }>;
export type InstructionPreview = Readonly<{ purpose:'loopback-public-test-only'; programId:string; keys:readonly AccountMeta[]; dataHex:string }>;
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
const RENT = 'SysvarRent111111111111111111111111111111111';
const bytes = (s:string):Uint8Array => Uint8Array.from(s.match(/../g)!.map(x=>parseInt(x,16)));
const hex = (s:Uint8Array):string => Array.from(s, x=>x.toString(16).padStart(2,'0')).join('');
function concat(...parts:Uint8Array[]):Uint8Array { const out=new Uint8Array(parts.reduce((sum,x)=>sum+x.length,0)); let i=0; for(const p of parts){out.set(p,i);i+=p.length;}return out; }
function u64(v:bigint,positive=false):Uint8Array { if(positive)positiveU64(v);if(typeof v!=='bigint'||v<0n||v>=(1n<<64n))throw new Error('Invalid u64');const out=new Uint8Array(8);new DataView(out.buffer).setBigUint64(0,v,true);return out; }
function u16(v:number):Uint8Array { if(!Number.isInteger(v)||v<0||v>100)throw new Error('Invalid fee bps');const out=new Uint8Array(2);new DataView(out.buffer).setUint16(0,v,true);return out; }
function text(v:string,max:number):Uint8Array {if(typeof v!=='string')throw new Error('Expected text');const b=new TextEncoder().encode(v);if(b.length>max)throw new Error('Metadata length exceeds limit');const n=new Uint8Array(4);new DataView(n.buffer).setUint32(0,b.length,true);return concat(n,b);}
const m=(pubkey:string,isWritable=false,isSigner=false):AccountMeta=>{publicKey(pubkey);return Object.freeze({pubkey,isWritable,isSigner});};
function preview(c:LocalContext, keys:AccountMeta[], tag:string, ...parts:Uint8Array[]):InstructionPreview {
  const url=new URL(c.rpcUrl);publicKey(c.programId);
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||c.programId===DEPLOYMENT.programId)throw new Error('Only isolated loopback test identities allowed');
  return Object.freeze({purpose:'loopback-public-test-only',programId:c.programId,keys:Object.freeze(keys),dataHex:hex(concat(bytes(tag),...parts))});
}
export interface MarketKeys { market:string; baseMint:string; quoteMint:string; lpMint:string; baseVault:string; quoteVault:string; lpLock:string; protocol:string }
export interface TradeKeys extends MarketKeys { trader:string; userBase:string; userQuote:string }
export interface LiquidityKeys extends TradeKeys { userLp:string }
export interface CreateArgs { nonce:bigint; name:string; symbol:string; metadataUri:string; supply:bigint; virtualQuote:bigint; graduationQuote:bigint; feeBps:number }
// PDA addresses are supplied from the local program ID/IDL by the caller. The on-chain program enforces seeds and ownership.
export function previewCreate(c:LocalContext,a:MarketKeys & {creator:string},v:CreateArgs):InstructionPreview {
  return preview(c,[m(a.creator,true,true),m(a.market,true),m(a.baseMint,true),m(a.quoteMint),m(a.lpMint,true),m(a.baseVault,true),m(a.quoteVault,true),m(a.lpLock,true),m(TOKEN),m(SYSTEM),m(RENT),m(a.protocol)],'67e261ebc8bcfbfe',u64(v.nonce),text(v.name,32),text(v.symbol,10),text(v.metadataUri,200),u64(v.supply,true),u64(v.virtualQuote,true),u64(v.graduationQuote,true),u16(v.feeBps));
}
export function previewSwap(c:LocalContext,a:TradeKeys,v:{buy:boolean;amountIn:bigint;minimumOut:bigint;version:bigint;deadlineSlot:bigint}):InstructionPreview {
  if(typeof v.buy!=='boolean')throw new Error('Expected boolean direction');return preview(c,[m(a.trader,false,true),m(a.market,true),m(a.baseMint),m(a.quoteMint),m(a.baseVault,true),m(a.quoteVault,true),m(a.userBase,true),m(a.userQuote,true),m(TOKEN),m(a.protocol)],'f8c69e91e17587c8',Uint8Array.of(v.buy?1:0),u64(v.amountIn,true),u64(v.minimumOut,true),u64(v.version),u64(v.deadlineSlot,true));
}
export function previewGraduate(c:LocalContext,a:MarketKeys,v:{version:bigint;deadlineSlot:bigint}):InstructionPreview {
  return preview(c,[m(a.market,true),m(a.baseMint,true),m(a.quoteMint),m(a.lpMint,true),m(a.baseVault,true),m(a.quoteVault),m(a.lpLock,true),m(TOKEN),m(a.protocol)],'2debe1b511da4082',u64(v.version),u64(v.deadlineSlot,true));
}
function lpKeys(a:LiquidityKeys):AccountMeta[]{return [m(a.trader,false,true),m(a.market,true),m(a.baseMint),m(a.quoteMint),m(a.lpMint,true),m(a.baseVault,true),m(a.quoteVault,true),m(a.lpLock),m(a.userBase,true),m(a.userQuote,true),m(a.userLp,true),m(TOKEN),m(a.protocol)];}
export function previewAddLiquidity(c:LocalContext,a:LiquidityKeys,v:{maxBase:bigint;maxQuote:bigint;minShares:bigint;version:bigint;deadlineSlot:bigint}):InstructionPreview {return preview(c,lpKeys(a),'b59d59438fb63448',u64(v.maxBase,true),u64(v.maxQuote,true),u64(v.minShares,true),u64(v.version),u64(v.deadlineSlot,true));}
export function previewRemoveLiquidity(c:LocalContext,a:LiquidityKeys,v:{shares:bigint;minBase:bigint;minQuote:bigint;version:bigint;deadlineSlot:bigint}):InstructionPreview {return preview(c,lpKeys(a),'5055d14818ceb16c',u64(v.shares,true),u64(v.minBase,true),u64(v.minQuote,true),u64(v.version),u64(v.deadlineSlot,true));}
