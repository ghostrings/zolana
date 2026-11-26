/** Read-only operator CLI. It never reads a keypair or sends a transaction. */
import { createReadRpc, observeDeployment, discoverMarkets, lookupMarket, recentActivity } from '../shared/src/ghost-markets/observe.js';
async function main():Promise<void>{
  const [command='status',address,...rest]=process.argv.slice(2);
  if(rest.length || !['status','scan','market','history'].includes(command) || (command==='market'?!address:!!address)) throw new Error('Usage: npm run markets:observe -- status|scan|history|market ADDRESS');
  const endpoint=process.env.GHOST_MAINNET_RPC||'https://api.mainnet-beta.solana.com';
  if(new URL(endpoint).protocol!=='https:')throw new Error('Trusted HTTPS mainnet RPC required');
  const rpc=createReadRpc(endpoint);
  const deployment=await observeDeployment(rpc);
  const result=command==='scan'?await discoverMarkets(rpc):command==='market'?await lookupMarket(rpc,address!):command==='history'?await recentActivity(rpc):undefined;
  console.log(JSON.stringify({deployment,...(result===undefined?{}:{result})},null,2));
}
main().catch(()=>{console.error('GHOST Markets read failed: RPC unavailable, release mismatch or invalid request. No transaction was sent.');process.exitCode=1;});
