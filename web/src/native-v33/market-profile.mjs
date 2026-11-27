/** V41 dual-profile public arithmetic. V33 account bytes, fee math and old market caps remain intact. */
import { Buffer } from 'buffer';
import {parseUnits,parseVersion} from '../../../protocol/ghost-markets-pilot/lab/core.mjs';
import {nativeSwap,accrueFees,readFeeLedger,grossForNet} from '../../../protocol/ghost-markets-pilot/reference/native-fees.mjs';
import {CURVE,READY,POOL,graduate} from '../../../protocol/ghost-markets-pilot/reference/lifecycle.mjs';
export const SUPPLY=1_000_000_000_000n;
export const LEGACY=Object.freeze({virtualQuote:100_000_000n,graduationQuote:200_000_000n,quoteCap:1_000_000_000n});
export const OPEN=Object.freeze({virtualQuote:3_500_000_000n,graduationQuote:12_040_270_268n,quoteCap:25_000_000_000n});
export function marketProfile(s){for(const p of [LEGACY,OPEN])if(BigInt(s.virtualQuote)===p.virtualQuote&&BigInt(s.graduationQuote)===p.graduationQuote)return p;throw Error('Unknown native market profile');}
export function marketState(data){
 const b=Buffer.from(data);if(b.length!==611||b.subarray(0,8).toString('hex')!=='dbbed53700e3c69a'||b[8]!==2||![CURVE,READY,POOL].includes(b[10]))throw Error('Invalid market schema');
 const s={phase:b[10],version:b.readBigUInt64LE(243),base:b.readBigUInt64LE(251),quote:b.readBigUInt64LE(259),virtualQuote:b.readBigUInt64LE(267),graduationQuote:b.readBigUInt64LE(275),feeBps:BigInt(b.readUInt16LE(283))};
 const p=marketProfile(s),f=readFeeLedger(b);if(![200n,300n,400n].includes(s.feeBps)||b.readBigUInt64LE(285)!==SUPPLY||s.base===0n||s.base>SUPPLY||s.quote+f.platform+f.creator>p.quoteCap)throw Error('Invalid market profile or accounting');return s;
}
export function quoteAction(s,lpSupply,lpLocked,mode,body,owed={platform:0n,creator:0n}){
 if(parseVersion(body.version)!==s.version)throw Error('Market version changed; refresh quote');const action=body.action,p=marketProfile(s);
 if(mode!==1&&!(mode===2&&(action==='graduate'||(action==='sell'&&[CURVE,POOL].includes(s.phase)))))throw Error('Action blocked by protocol mode');
 if(action==='graduate'){const g=graduate(s);return {action,baseToBurn:g.baseToBurn,lockedLp:g.lockedLp,next:g.next};}
 if(!['buy','sell'].includes(action))throw Error('Native markets: all LP principal is locked');
 const buy=action==='buy',amountIn=parseUnits(body.amount,buy?9:6);
 if(buy&&p===OPEN&&s.phase===CURVE&&amountIn>grossForNet(s.graduationQuote-s.quote,s.feeBps))throw Error('Buy exceeds remaining graduation reserve. Maximum gross input in lamports: '+grossForNet(s.graduationQuote-s.quote,s.feeBps));
 const q=nativeSwap(s,buy,amountIn),nextOwed=accrueFees(owed,q);
 if(buy&&p===OPEN&&s.phase===CURVE&&q.next.quote>s.graduationQuote)throw Error('Graduation overshoot');
 if(buy&&q.next.quote+nextOwed.platform+nextOwed.creator>p.quoteCap)throw Error('Accounted reserve and unpaid fee cap exceeded');
 return {action,amountIn,minimumOut:q.amountOut,fee:q.fee,platformFee:q.platform,creatorFee:q.creator,nextOwed,next:q.next};
}
export function beneficiaryOwed(wallet,creator,treasury,fees){return (wallet===treasury?fees.platform:0n)+(wallet===creator?fees.creator:0n);}
