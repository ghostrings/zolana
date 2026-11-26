import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMarket,guard,swap,graduate,addLiquidity,removeLiquidity,sqrt,CURVE,READY,POOL,MIN_CURVE_BASE} from '../reference/lifecycle.mjs';
import {U64_MAX} from '../reference/quote.mjs';
const initial=()=>createMarket({supply:1_000_000n,virtualQuote:100_000n,graduationQuote:200_000n,feeBps:30n});
const pool=()=>graduate(swap(initial(),true,200_000n).next);
let seed=7n;function rand(){seed=(1664525n*seed+1013904223n)&0xffffffffn;return seed;}
test('creation: zero quote, immutable parameters and full initial inventory',()=>{
 const a=initial(); assert.deepEqual(a,{phase:CURVE,version:0n,base:1_000_000n,quote:0n,virtualQuote:100_000n,graduationQuote:200_000n,feeBps:30n}); assert.ok(Object.isFrozen(a));
});
test('reject invalid configuration',()=>{
 for(const p of [{supply:1_999n},{virtualQuote:999n},{graduationQuote:99_999n},{feeBps:101n},{graduationQuote:U64_MAX},{supply:2_000n}]) assert.throws(()=>createMarket({supply:1_000_000n,virtualQuote:100_000n,graduationQuote:200_000n,feeBps:30n,...p}));
});
test('reject wrong phase and sale before actual quote liquidity',()=>{const a=initial();assert.throws(()=>graduate(a));assert.throws(()=>swap(a,false,1_000n));assert.throws(()=>addLiquidity(a,1n,1n,1n));});
test('curve buy deterministic exact quote',()=>{const a=initial();const b=swap(a,true,50_000n);assert.equal(b.amountOut,332_665n);assert.equal(b.fee,150n);assert.equal(b.next.base,667_335n);assert.equal(b.next.quote,50_000n);assert.equal(b.next.version,1n);assert.equal(a.quote,0n);});
test('curve sell respects real reserve and round trip has no profit',()=>{const a=initial(),b=swap(a,true,50_000n),c=swap(b.next,false,b.amountOut);assert.ok(c.amountOut<50_000n);assert.ok(c.next.quote>0n);assert.equal(c.next.base,a.base);});
test('minimum output and stale or expired quotes reject',()=>{const a=initial();assert.throws(()=>swap(a,true,50_000n,332_666n));assert.throws(()=>guard(a,1n,10n,9n),/stale/);assert.throws(()=>guard(a,0n,8n,9n),/expired/);guard(a,0n,9n,9n);});
test('overflow, fee dust and real reserve floor reject',()=>{assert.throws(()=>swap(initial(),true,U64_MAX));assert.throws(()=>swap(initial(),true,1n));assert.throws(()=>swap(initial(),true,200_000_000n));assert.throws(()=>swap(initial(),true,0n));});
test('threshold latches READY, blocks both directions',()=>{const a=swap(initial(),true,200_000n).next;assert.equal(a.phase,READY);assert.throws(()=>swap(a,true,10_000n));assert.throws(()=>swap(a,false,10_000n));});
test('graduation burns only unsold base, preserves all quote, locks initial LP',()=>{const a=swap(initial(),true,200_000n).next,g=graduate(a);assert.equal(g.next.phase,POOL);assert.equal(g.next.base+g.baseToBurn,a.base);assert.equal(g.next.quote,a.quote);assert.equal(g.lockedLp,sqrt(g.next.base*g.next.quote));assert.equal(g.next.version,2n);assert.throws(()=>graduate(g.next));});
test('graduation price is conserved up to floor rounding',()=>{const a=swap(initial(),true,200_000n).next,g=graduate(a),eff=a.quote+a.virtualQuote;assert.ok(g.next.base*eff<=a.base*a.quote);assert.ok((g.next.base+1n)*eff>a.base*a.quote);});
test('pool uses no virtual reserves, fee retained',()=>{const g=pool(),q=swap(g.next,true,10_000n),net=10_000n-q.fee;assert.equal(q.amountOut,g.next.base*net/(g.next.quote+net));assert.ok(q.next.base*q.next.quote>=g.next.base*g.next.quote);});
test('proportional add rounds input up, respects user maximums',()=>{const g=pool(),a=addLiquidity(g.next,g.lockedLp,50_000n,50_000n);assert.ok(a.baseAmount<=50_000n&&a.quoteAmount<=50_000n);assert.ok(a.baseAmount*g.lockedLp>=a.shares*g.next.base);assert.ok(a.quoteAmount*g.lockedLp>=a.shares*g.next.quote);assert.throws(()=>addLiquidity(g.next,g.lockedLp,50_000n,50_000n,a.shares+1n));});
test('remove rounds output down, prevents free liquidity round trip',()=>{const g=pool(),a=addLiquidity(g.next,g.lockedLp,50_000n,50_000n),r=removeLiquidity(a.next,g.lockedLp+a.shares,g.lockedLp,a.shares);assert.ok(r.baseAmount<=a.baseAmount&&r.quoteAmount<=a.quoteAmount);assert.ok(r.next.base>=g.next.base&&r.next.quote>=g.next.quote);});
test('lock cannot be redeemed, live supply used after external burns',()=>{const g=pool(),a=addLiquidity(g.next,g.lockedLp,50_000n,50_000n),burned=a.shares/3n,supply=g.lockedLp+a.shares-burned;assert.throws(()=>removeLiquidity(a.next,supply,g.lockedLp,a.shares));const r=removeLiquidity(a.next,supply,g.lockedLp,a.shares-burned);assert.ok(r.next.base>0n&&r.next.quote>0n);assert.throws(()=>removeLiquidity(g.next,g.lockedLp,g.lockedLp,1n));});
test('LP zero, overflow, output dust and minimums reject',()=>{const g=pool();assert.throws(()=>addLiquidity(g.next,0n,1n,1n));assert.throws(()=>addLiquidity(g.next,U64_MAX,1n,1n));assert.throws(()=>removeLiquidity(g.next,100n,1n,1n,g.next.base,1n));assert.throws(()=>removeLiquidity(g.next,0n,0n,1n));});
test('integer sqrt boundaries',()=>{for(const n of [0n,1n,2n,3n,4n,10n,(1n<<128n)-1n]){const y=sqrt(n);assert.ok(y*y<=n&&(y===U64_MAX||(y+1n)**2n>n));}});
test('128 committed lifecycle vectors reproduce exactly',()=>{const p=fileURLToPath(new URL('../reference/generate-vectors.mjs',import.meta.url)),out=spawnSync(process.execPath,[p],{encoding:'utf8'});assert.equal(out.status,0,out.stderr);const fixture=readFileSync(new URL('../reference/lifecycle-vectors.csv',import.meta.url),'utf8');assert.equal(out.stdout,fixture);assert.equal(fixture.trim().split('\n').length,129);});
test('5,000 deterministic curve and pool transitions preserve reserve/LP invariants',()=>{
 for(let i=0;i<5_000;i++){
  const supply=1_000_000n+rand()%10_000_000n,v=100_000n+rand()%1_000_000n,t=v+rand()%(3n*v),fee=rand()%101n;
  const a=createMarket({supply,virtualQuote:v,graduationQuote:t,feeBps:fee}),q=swap(a,true,t+rand()%v);
  assert.equal(q.next.phase,READY);assert.ok(q.next.base>=MIN_CURVE_BASE);assert.ok(q.next.base*(q.next.quote+v)>=a.base*v);assert.equal(q.next.base+q.amountOut,a.base);
  const g=graduate(q.next);assert.ok(g.next.base+g.baseToBurn===q.next.base);assert.ok(g.next.base*(g.next.quote+v)<=q.next.base*g.next.quote);
  const x=swap(g.next,true,1_000n+rand()%10_000n);assert.ok(x.next.base*x.next.quote>=g.next.base*g.next.quote);
  const l=addLiquidity(x.next,g.lockedLp,10_000n+rand()%100_000n,10_000n+rand()%100_000n);
  const r=removeLiquidity(l.next,g.lockedLp+l.shares,g.lockedLp,l.shares);
  assert.ok(r.baseAmount<=l.baseAmount&&r.quoteAmount<=l.quoteAmount);assert.ok(r.next.base>=x.next.base&&r.next.quote>=x.next.quote);
 }
});
