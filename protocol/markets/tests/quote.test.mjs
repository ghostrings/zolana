import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteExactIn as quote, U64_MAX } from '../src/quote.mjs';
const base = { reserveIn: 1_000n, reserveOut: 1_000n, amountIn: 100n };
test('constant-product exact input rounds output down', () => {
  assert.deepEqual(quote(base), { amountIn:100n,fee:0n,net:100n,amountOut:90n,nextReserveIn:1100n,nextReserveOut:910n });
});
test('fee rounds up and is retained in input reserve', () => {
  assert.deepEqual(quote({ ...base, feeBps: 30n }), { amountIn:100n,fee:1n,net:99n,amountOut:90n,nextReserveIn:1100n,nextReserveOut:910n });
});
test('slippage bound enforced', () => assert.throws(() => quote({ ...base, minimumOut:91n }), /minimum/));
test('zero input and wrong units rejected', () => { for (const amountIn of [0n, -1n, 1, '1', U64_MAX+1n]) assert.throws(() => quote({ ...base,amountIn }), /u64/); });
test('fee bound enforced', () => assert.throws(() => quote({ ...base,feeBps:10000n }), /feeBps/));
test('dust fee cannot consume input', () => assert.throws(() => quote({ ...base,amountIn:1n,feeBps:1n }), /consumes/));
test('dust quote cannot output zero', () => assert.throws(() => quote({ ...base,reserveOut:1n,amountIn:1n }), /minimum/));
test('effective reserve overflow rejected', () => assert.throws(() => quote({ ...base,reserveIn:U64_MAX,virtualIn:1n }), /u64/));
test('post-fee input reserve overflow rejected', () => assert.throws(() => quote({ ...base,reserveIn:U64_MAX-2n,reserveOut:U64_MAX,amountIn:3n,feeBps:3334n }), /u64/));
test('virtual inventory is never spendable', () => assert.throws(() => quote({ reserveIn:100n,reserveOut:10n,virtualOut:1000n,amountIn:100n }), /real output/));
test('virtual launch reserve can start at zero real quote reserve', () => { const q=quote({ reserveIn:0n,virtualIn:1000n,reserveOut:1000n,amountIn:100n }); assert.equal(q.amountOut,90n); assert.equal(q.nextReserveIn,100n); });
test('no effective input liquidity rejected', () => assert.throws(() => quote({ ...base,reserveIn:0n }), /positive/));
test('10,000 deterministic public quote property checks', () => {
  let seed=42n; const rand=()=>{seed=(1664525n*seed+1013904223n)&0xffffffffn;return seed;};
  let checked=0;
  for(let i=0;i<10000;i++){
    const x=10000n+rand()%1000000n, y=10000n+rand()%1000000n, input=100n+rand()%100000n, feeBps=rand()%101n;
    const q=quote({reserveIn:x,reserveOut:y,amountIn:input,feeBps});
    assert(q.amountOut>0n && q.amountOut<y);
    assert.equal(q.net+q.fee,input);
    assert.equal(q.nextReserveIn,x+input);
    assert.equal(q.nextReserveOut,y-q.amountOut);
    assert(q.nextReserveIn*q.nextReserveOut>=x*y);
    assert.equal(q.amountOut,y*q.net/(x+q.net));
    checked++;
  }
  assert.equal(checked,10000);
});
