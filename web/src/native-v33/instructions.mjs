/** V33 canonical public-SPL instruction builders. Pinned mainnet identity. No signer or sending. */
import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { PROFILE, assertMetadata } from '../../../protocol/ghost-markets-pilot/reference/pilot-profile.mjs';
import { checkedMetadataUri } from './launch-policy.mjs';
import { feeTier } from '../../../protocol/ghost-markets-pilot/reference/native-fees.mjs';
const LIVE='5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const TAGS=Object.freeze({"claim_fees":[82,251,233,156,12,52,184,202],"create_market":[103,226,97,235,200,188,251,254],"graduate":[45,235,225,181,17,218,64,130],"initialize_protocol":[188,233,252,106,134,146,202,91],"swap":[248,198,158,145,225,117,135,200]});
const tag=name=>{if(!Object.hasOwn(TAGS,name))throw Error('Instruction refused');return Buffer.from(TAGS[name]);};
export function u64(v) { if(typeof v!=='bigint'||v<0n||v>0xffffffffffffffffn)throw new RangeError('Invalid u64');const b=Buffer.alloc(8);b.writeBigUInt64LE(v);return b; }
function u16(v) { const b=Buffer.alloc(2);b.writeUInt16LE(Number(v));return b; }
function str(s) { const bytes=Buffer.from(s,'utf8'),len=Buffer.alloc(4);len.writeUInt32LE(bytes.length);return Buffer.concat([len,bytes]); }
const m=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const pda=(pid,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),pid)[0];
export const context=Object.freeze({pid:new PublicKey(LIVE)});
function ix(c,name,keys,...parts) {
 if(c!==context)throw Error('Pinned V33 context required');
 return new TransactionInstruction({programId:c.pid,keys,data:Buffer.concat([tag(name),...parts])});
}
export function marketKeys(c,creator,nonce) {
 const market=pda(c.pid,'market',creator.toBuffer(),u64(nonce));
 const [baseMint,lpMint,baseVault,quoteVault,lpLock]=['base-mint','lp-mint','base-vault','quote-vault','lp-lock'].map(seed=>pda(c.pid,seed,market.toBuffer()));
 return {market,baseMint,lpMint,baseVault,quoteVault,lpLock,quoteMint:NATIVE_MINT,protocol:pda(c.pid,'protocol')};
}
export function initialize(c,authority,pauser,treasury) {return ix(c,'initialize_protocol',[m(authority,true,true),m(c.pid),m(pda(LOADER,c.pid.toBuffer())),m(pda(c.pid,'protocol'),true),m(SystemProgram.programId),m(treasury,false,true)],pauser.toBuffer());}
export function create(c,creator,nonce,name,symbol,{feeBps,approver,metadataUri=''}) {
 assertMetadata(name,symbol);if(!approver||creator.equals(approver))throw Error('Distinct approver required');const quoteMint=NATIVE_MINT,supply=PROFILE.supply,k=marketKeys(c,creator,nonce);
 return ix(c,'create_market',[m(creator,true,true),m(k.market,true),m(k.baseMint,true),m(quoteMint),m(k.lpMint,true),m(k.baseVault,true),m(k.quoteVault,true),m(k.lpLock,true),m(TOKEN_PROGRAM_ID),m(SystemProgram.programId),m(SYSVAR_RENT_PUBKEY),m(k.protocol),...(approver?[m(approver,false,true)]:[])],u64(nonce),str(name),str(symbol),str(checkedMetadataUri(metadataUri,true)),u64(supply),u64(PROFILE.virtualQuote),u64(PROFILE.graduationQuote),u16(feeTier(feeBps)));
}
export function swapIx(c,k,trader,userBase,userQuote,{buy,amountIn,minimumOut,version,deadline}) {
 if(typeof buy!=='boolean'||amountIn<=0n||minimumOut<=0n)throw new Error('Invalid trade');
 return ix(c,'swap',[m(trader,false,true),m(k.market,true),m(k.baseMint),m(k.quoteMint),m(k.baseVault,true),m(k.quoteVault,true),m(userBase,true),m(userQuote,true),m(TOKEN_PROGRAM_ID),m(k.protocol)],Buffer.from([buy?1:0]),u64(amountIn),u64(minimumOut),u64(version),u64(deadline));
}
export function graduateIx(c,k,version,deadline) {return ix(c,'graduate',[m(k.market,true),m(k.baseMint,true),m(k.quoteMint),m(k.lpMint,true),m(k.baseVault,true),m(k.quoteVault),m(k.lpLock,true),m(TOKEN_PROGRAM_ID),m(k.protocol)],u64(version),u64(deadline));}
export function claimFeesIx(c,k,recipient,destination){return ix(c,'claim_fees',[m(recipient,false,true),m(k.market,true),m(k.quoteMint),m(k.quoteVault,true),m(destination,true),m(TOKEN_PROGRAM_ID),m(k.protocol)]);}
/** V41 candidate instruction; distinct from the historical V33 approval builder. */
export function createPermissionless(c,creator,nonce,name,symbol,{feeBps,metadataUri=''}) {
 assertMetadata(name,symbol);const k=marketKeys(c,creator,nonce);
 return ix(c,'create_market',[m(creator,true,true),m(k.market,true),m(k.baseMint,true),m(NATIVE_MINT),m(k.lpMint,true),m(k.baseVault,true),m(k.quoteVault,true),m(k.lpLock,true),m(TOKEN_PROGRAM_ID),m(SystemProgram.programId),m(SYSVAR_RENT_PUBKEY),m(k.protocol)],u64(nonce),str(name),str(symbol),str(checkedMetadataUri(metadataUri,true)),u64(1_000_000_000_000n),u64(3_500_000_000n),u64(12_040_270_268n),u16(feeTier(feeBps)));
}
