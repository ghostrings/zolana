/** Actual public SPL instruction builders, restricted to the fresh local test program. No signing or sending. */
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { PROFILE, assertMetadata } from './pilot-profile.mjs';
import { feeTier } from './native-fees.mjs';
const LIVE='5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const tag=name=>createHash('sha256').update(`global:${name}`).digest().subarray(0,8);
export function u64(v) { if(typeof v!=='bigint'||v<0n||v>0xffffffffffffffffn)throw new RangeError('Invalid u64');const b=Buffer.alloc(8);b.writeBigUInt64LE(v);return b; }
function u16(v) { const b=Buffer.alloc(2);b.writeUInt16LE(Number(v));return b; }
function str(s) { const bytes=Buffer.from(s,'utf8'),len=Buffer.alloc(4);len.writeUInt32LE(bytes.length);return Buffer.concat([len,bytes]); }
const m=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const pda=(pid,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),pid)[0];
export function localContext(rpcUrl,programId) {
 const url=new URL(rpcUrl),pid=new PublicKey(programId);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||pid.toBase58()===LIVE)throw new Error('Only a fresh loopback program is allowed');
 return Object.freeze({rpcUrl:url.href,pid});
}
function ix(c,name,keys,...parts) {
 localContext(c.rpcUrl,c.pid);return new TransactionInstruction({programId:c.pid,keys,data:Buffer.concat([tag(name),...parts])});
}
export function marketKeys(c,creator,nonce) {
 const market=pda(c.pid,'market',creator.toBuffer(),u64(nonce));
 const [baseMint,lpMint,baseVault,quoteVault,lpLock]=['base-mint','lp-mint','base-vault','quote-vault','lp-lock'].map(seed=>pda(c.pid,seed,market.toBuffer()));
 return {market,baseMint,lpMint,baseVault,quoteVault,lpLock,quoteMint:NATIVE_MINT,protocol:pda(c.pid,'protocol')};
}
export function initialize(c,authority,pauser,treasury) {return ix(c,'initialize_protocol',[m(authority,true,true),m(c.pid),m(pda(LOADER,c.pid.toBuffer())),m(pda(c.pid,'protocol'),true),m(SystemProgram.programId),m(treasury,false,true)],pauser.toBuffer());}
export function setMode(c,authority,mode) {if(![1,2].includes(mode))throw new Error('Invalid mode');return ix(c,'set_protocol_mode',[m(authority,false,true),m(pda(c.pid,'protocol'),true)],Buffer.from([mode]));}
export function create(c,creator,nonce,name,symbol,{quoteMint=NATIVE_MINT,supply=PROFILE.supply,feeBps=PROFILE.feeBps,approver,virtualQuote=PROFILE.virtualQuote,graduationQuote=PROFILE.graduationQuote}={}) {
 assertMetadata(name,symbol);const k=marketKeys(c,creator,nonce);
 return ix(c,'create_market',[m(creator,true,true),m(k.market,true),m(k.baseMint,true),m(quoteMint),m(k.lpMint,true),m(k.baseVault,true),m(k.quoteVault,true),m(k.lpLock,true),m(TOKEN_PROGRAM_ID),m(SystemProgram.programId),m(SYSVAR_RENT_PUBKEY),m(k.protocol),...(approver?[m(approver,false,true)]:[])],u64(nonce),str(name),str(symbol),str(''),u64(supply),u64(virtualQuote),u64(graduationQuote),u16(feeTier(feeBps)));
}
export function swapIx(c,k,trader,userBase,userQuote,{buy,amountIn,minimumOut,version,deadline}) {
 if(typeof buy!=='boolean'||amountIn<=0n||minimumOut<=0n)throw new Error('Invalid trade');
 return ix(c,'swap',[m(trader,false,true),m(k.market,true),m(k.baseMint),m(k.quoteMint),m(k.baseVault,true),m(k.quoteVault,true),m(userBase,true),m(userQuote,true),m(TOKEN_PROGRAM_ID),m(k.protocol)],Buffer.from([buy?1:0]),u64(amountIn),u64(minimumOut),u64(version),u64(deadline));
}
export function graduateIx(c,k,version,deadline) {return ix(c,'graduate',[m(k.market,true),m(k.baseMint,true),m(k.quoteMint),m(k.lpMint,true),m(k.baseVault,true),m(k.quoteVault),m(k.lpLock,true),m(TOKEN_PROGRAM_ID),m(k.protocol)],u64(version),u64(deadline));}
export function liquidityIx(c,k,trader,userBase,userQuote,userLp,add,args,version,deadline) {
 if(typeof add!=='boolean'||args.length!==3||args.some(a=>typeof a!=='bigint'||a<=0n))throw new Error('Invalid liquidity amounts');
 return ix(c,add?'add_liquidity':'remove_liquidity',[m(trader,false,true),m(k.market,true),m(k.baseMint),m(k.quoteMint),m(k.lpMint,true),m(k.baseVault,true),m(k.quoteVault,true),m(k.lpLock),m(userBase,true),m(userQuote,true),m(userLp,true),m(TOKEN_PROGRAM_ID),m(k.protocol)],...args.map(u64),u64(version),u64(deadline));
}

export function claimFeesIx(c,k,recipient,destination){return ix(c,'claim_fees',[m(recipient,false,true),m(k.market,true),m(k.quoteMint),m(k.quoteVault,true),m(destination,true),m(TOKEN_PROGRAM_ID),m(k.protocol)]);}
