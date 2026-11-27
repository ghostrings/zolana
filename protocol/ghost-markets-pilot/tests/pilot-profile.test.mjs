import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PROFILE,assertMetadata,assertQuoteCap} from '../reference/pilot-profile.mjs';
import {createNativeMarket,nativeSwap,grossForNet,splitNativeFee,accrueFees,FEE_TIERS,feeTier} from '../reference/native-fees.mjs';
import {graduate,POOL,READY,CURVE} from '../reference/lifecycle.mjs';
const src=readFileSync(new URL('../programs/ghost-markets/src/lib.rs',import.meta.url),'utf8');
const math=readFileSync(new URL('../crates/market-math/src/lib.rs',import.meta.url),'utf8');
test('profile agrees with Rust constants and native authorization guards',()=>{
 for(const [key,field] of [['PILOT_SUPPLY','supply'],['PILOT_VIRTUAL_QUOTE','virtualQuote'],['PILOT_GRADUATION_QUOTE','graduationQuote'],['PILOT_QUOTE_CAP','quoteCap']]) {
  const m=src.match(new RegExp(`const ${key}: u\\d+ = ([0-9_]+);`));assert.ok(m,key);assert.equal(BigInt(m[1].replaceAll('_','')),PROFILE[field]);
 }
 assert.match(math,/NATIVE_FEE_TIERS: \[u16; 3\] = \[200, 300, 400\]/);assert.match(src,/approver.is_signer && approver.key\(\) == ctx.accounts.protocol.admin/);
 assert.match(src,/spl_token::native_mint::ID/);assert.match(src,/compile_error!\("local-market-testing and public-pilot are mutually exclusive"\)/);
 assert.equal((src.match(/require!\(!PUBLIC_PILOT, ErrorCode::LockedLiquidityOnly\)/g)||[]).length,2);
});
for(const feeBps of FEE_TIERS)test(`tier ${feeBps} bps: WSOL fee conservation and locked pool allocation`,()=>{
 let s=createNativeMarket({...PROFILE,feeBps}),owed={platform:0n,creator:0n};
 const buy=nativeSwap(s,true,50_000_000n);assert.equal(buy.fee,50_000_000n*feeBps/10000n);assert.equal(buy.next.quote+buy.fee,50_000_000n);assert.equal(buy.creator,buy.fee/5n);assert.equal(buy.platform+buy.creator,buy.fee);s=buy.next;owed=accrueFees(owed,buy);
 const sell=nativeSwap(s,false,10_000_000_000n);assert.equal(s.quote-sell.next.quote,sell.amountOut+sell.fee);assert.equal(sell.next.base-s.base,10_000_000_000n);assert.equal(sell.creator,sell.fee/5n);assert.equal(sell.platform+sell.creator,sell.fee);s=sell.next;owed=accrueFees(owed,sell);
 const last=nativeSwap(s,true,grossForNet(PROFILE.graduationQuote-s.quote,feeBps));s=last.next;owed=accrueFees(owed,last);assert.equal(s.phase,READY);assert.equal(s.quote,PROFILE.graduationQuote);assertQuoteCap(s,owed.platform+owed.creator);
 const g=graduate(s);s=g.next;assert.equal(s.phase,POOL);assert.ok(g.lockedLp>0n);
 for(const [buy,amount] of [[true,10_000_000n],[false,1_000_000_000n]]){const p=nativeSwap(s,buy,amount);assert.equal(p.platform,p.fee);assert.equal(p.creator,0n);assert.throws(()=>nativeSwap(s,buy,amount,p.amountOut+1n));s=p.next;owed=accrueFees(owed,p);assertQuoteCap(s,owed.platform+owed.creator);}
});
test('tier validation and rounding never creates or loses fees',()=>{for(const b of [0n,30n,100n,201n,500n,200])assert.throws(()=>feeTier(b));for(let i=0n;i<5000n;i++){const p=splitNativeFee(CURVE,i),g=splitNativeFee(POOL,i);assert.equal(p.creator,i/5n);assert.equal(p.creator+p.platform,i);assert.deepEqual(g,{platform:i,creator:0n});}assert.throws(()=>splitNativeFee(READY,1n));});
test('cap includes fees; rejects overshoot but not equality',()=>{const s=createNativeMarket(PROFILE),q=nativeSwap(s,true,PROFILE.quoteCap+1n);assert.throws(()=>assertQuoteCap(q.next,q.fee),/cap/);assert.doesNotThrow(()=>assertQuoteCap({quote:PROFILE.quoteCap-1n},1n));assert.throws(()=>assertQuoteCap({quote:PROFILE.quoteCap},1n));assert.throws(()=>assertQuoteCap({quote:-1n}));});
test('metadata limits include UTF-8 bytes and reject controls',()=>{assert.doesNotThrow(()=>assertMetadata('GHOST Local','GHOST1'));assert.throws(()=>assertMetadata('x'.repeat(33),'GHOST'));assert.throws(()=>assertMetadata('👻'.repeat(9),'GHOST'));assert.throws(()=>assertMetadata('a\n','GHOST'));assert.throws(()=>assertMetadata('ok','lower'));});

for(const feeBps of FEE_TIERS)test(`${feeBps} bps full curve exit and restart`,()=>{
 const initial=createNativeMarket({...PROFILE,feeBps});
 const bought=nativeSwap(initial,true,grossForNet(25_000_000n,feeBps));
 assert.equal(bought.next.quote,25_000_000n);assert.equal(bought.amountOut,200_000_000_000n);
 const sold=nativeSwap(bought.next,false,bought.amountOut);
 assert.equal(sold.next.quote,0n);assert.equal(sold.next.base,initial.base);assert.equal(sold.amountOut+sold.fee,bought.next.quote);
 assert.equal(sold.creator+sold.platform,sold.fee);assert.equal(sold.next.phase,CURVE);
 assert.throws(()=>nativeSwap(bought.next,false,bought.amountOut+1_000_000_000n));
 assert.throws(()=>nativeSwap(bought.next,false,bought.amountOut,sold.amountOut+1n));
 assert.doesNotThrow(()=>nativeSwap(sold.next,true,grossForNet(25_000_000n,feeBps)));
});
test('treasury is accepted independently, never selected by launch approver',()=>{
 assert.match(src,/pub treasury: Signer<'info>/);
 assert.match(src,/treasury != ctx.accounts.authority.key\(\) && treasury != pauser/);
 assert.match(src,/m.platform = a.protocol.treasury/);
 assert.match(src,/ctx.accounts.creator.key\(\) != ctx.accounts.protocol.treasury/);
 assert.match(src,/nominee != config.treasury/);
 assert.match(src,/pauser != config.treasury/);
});
