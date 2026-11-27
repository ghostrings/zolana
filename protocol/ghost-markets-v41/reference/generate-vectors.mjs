import { createMarket, swap, graduate, addLiquidity, removeLiquidity } from './lifecycle.mjs';
const columns=['supply','virtual_quote','graduation_quote','fee_bps','buy_input','buy_output','buy_fee','ready_base','ready_quote','ready_phase','pool_base','burned_base','locked_lp','max_base','max_quote','minted_lp','deposit_base','deposit_quote','withdraw_base','withdraw_quote','final_base','final_quote'];
let seed=0x47484f53n;
function rand(){seed=(1664525n*seed+1013904223n)&0xffffffffn;return seed;}
console.log(columns.join(','));
for(let i=0;i<128;i++){
  const supply=1_000_000n+rand()%10_000_000n,v=100_000n+rand()%1_000_000n,target=v+rand()%(3n*v),fee=rand()%101n,input=target+rand()%v;
  const a=createMarket({supply,virtualQuote:v,graduationQuote:target,feeBps:fee});
  const s=swap(a,true,input),g=graduate(s.next),maxBase=10_000n+rand()%200_000n,maxQuote=10_000n+rand()%200_000n;
  const l=addLiquidity(g.next,g.lockedLp,maxBase,maxQuote),r=removeLiquidity(l.next,g.lockedLp+l.shares,g.lockedLp,l.shares);
  console.log([supply,v,target,fee,input,s.amountOut,s.fee,s.next.base,s.next.quote,s.next.phase,g.next.base,g.baseToBurn,g.lockedLp,maxBase,maxQuote,l.shares,l.baseAmount,l.quoteAmount,r.baseAmount,r.quoteAmount,r.next.base,r.next.quote].join(','));
}
