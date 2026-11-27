/** Read-only operator checks, no wallet, private-key or submission API. */
import { readFile } from 'node:fs/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import { createReadRpc, discoverMarkets, digest, DEPLOYMENT } from '../shared/src/ghost-markets/observe.js';
import { V33, inspectNativeRelease, initializationPlan, reviewedRelease, scanV33 } from '../shared/src/ghost-markets/v33-release.js';
async function main(){
  const [action='preflight',...rest]=process.argv.slice(2);if(rest.length||!['preflight','initialization-plan'].includes(action))throw Error('Usage: npm run markets:production:preflight or markets:production:init-plan');
  if(action==='initialization-plan'){console.log(JSON.stringify(initializationPlan(),null,2));return;}
  const bin=await readFile(new URL('../deployments/review/v33-candidate/ghost_markets.so',import.meta.url));
  if(bin.length!==V33.binaryBytes||await digest(bin)!==V33.binarySha256)throw Error('Candidate checksum mismatch');
  const endpoint=process.env.GHOST_MAINNET_RPC||'https://api.mainnet-beta.solana.com';if(new URL(endpoint).protocol!=='https:')throw Error('HTTPS mainnet RPC required');
  const rpc=createReadRpc(endpoint),c=new Connection(endpoint,'finalized');
  const observation=await inspectNativeRelease(rpc);
  const scan=observation.release==='v27-locked'?await discoverMarkets(rpc):observation.config?await scanV33(rpc):null;
  const pd=await c.getAccountInfo(new PublicKey(V33.programData),'finalized');if(!pd||!pd.owner.equals(new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))||pd.data.length<45)throw Error('ProgramData unavailable');
  const target=Math.max(pd.data.length,45+V33.binaryBytes);
  const [rent,buffer,balance]=await Promise.all([c.getMinimumBalanceForRentExemption(target,'finalized'),c.getMinimumBalanceForRentExemption(37+V33.binaryBytes,'finalized'),c.getBalance(new PublicKey(V33.upgradeAuthority),'finalized')]);
  for(const n of [rent,buffer,balance,pd.lamports])if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid lamports');
  const additional=Math.max(0,rent-pd.lamports),estimate=additional+buffer;
  const after=await inspectNativeRelease(rpc);if(after.deploymentSlot!==observation.deploymentSlot||after.protocolInitialized!==observation.protocolInitialized)throw Error('State changed; rerun');
  console.log(JSON.stringify({observation,scan,authorities:{upgrade:V33.upgradeAuthority,admin:V33.admin,treasury:V33.treasury,pauser:V33.pauser},candidate:{bytes:V33.binaryBytes,binarySha256:V33.binarySha256,verifyHash:V33.verifyHash},allocation:{currentBytes:pd.data.length-45,requiredBytes:V33.binaryBytes,extensionBytes:Math.max(0,V33.binaryBytes-(pd.data.length-45)),minimumProgramDataRentLamports:rent,additionalRentLamports:additional,temporaryBufferRentEstimateLamports:buffer,feePayerBalanceLamports:balance,headroomBeforeFeesLamports:balance-estimate},reviewRecorded:reviewedRelease()!==null,compatibleEmptyV27:observation.release==='v27-locked'&&!observation.protocolInitialized&&scan?.markets.length===0&&observation.deploymentSlot===DEPLOYMENT.deploymentSlot,upgradeAuthorized:false,privateSettlement:false,warning:'Read-only estimates; additional allocation and fees may vary. No transaction sent.'},null,2));
}
main().catch(()=>{console.error('Native preflight failed; inspect the candidate, current RPC and deployment identity. No transaction sent.');process.exitCode=1;});
