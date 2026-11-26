/** Read-only mainnet preflight or byte verification. Never loads a private key. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { checkRelease, verifyProgramData } from './release-verify.mjs';
const [action, releaseDir, expectedProgram, expectedAuthority]=process.argv.slice(2);
assert.ok(['preflight','verify'].includes(action)&&releaseDir&&expectedProgram&&expectedAuthority,'Usage: mainnet-status.mjs preflight|verify RELEASE PROGRAM_ID UPGRADE_AUTHORITY');
const manifest=JSON.parse(readFileSync(join(releaseDir,'release.json'),'utf8'));
const binary=readFileSync(join(releaseDir,'ghost_markets.so'));
const idl=JSON.parse(readFileSync(join(releaseDir,'ghost_markets.json'),'utf8'));
checkRelease(manifest,binary,idl,expectedProgram);
assert.equal(manifest.plannedUpgradeAuthority,expectedAuthority,'Reviewed upgrade authority differs');
const pid=new PublicKey(expectedProgram),authority=new PublicKey(expectedAuthority);
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const [protocol]=PublicKey.findProgramAddressSync([Buffer.from('protocol')],pid);
const [programData]=PublicKey.findProgramAddressSync([pid.toBuffer()],loader);
const rpc=process.env.GHOST_MAINNET_RPC||'https://api.mainnet-beta.solana.com';
const url=new URL(rpc);assert.equal(url.protocol,'https:','Use an HTTPS mainnet RPC');
const c=new Connection(rpc,{commitment:'finalized',disableRetryOnRateLimit:true});
const genesis=await c.getGenesisHash();assert.equal(genesis,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','Not Solana mainnet-beta');
if(action==='preflight'){
  const [existing,data,config]=await c.getMultipleAccountsInfo([pid,programData,protocol],'confirmed');
  assert.equal(existing,null,'Program ID already has an account; refuse to upgrade or overwrite');
  assert.equal(data,null,'ProgramData already exists; investigate before proceeding');
  assert.equal(config,null,'Protocol config already exists; investigate before proceeding');
  const programRent=await c.getMinimumBalanceForRentExemption(36,'finalized');
  const dataRent=await c.getMinimumBalanceForRentExemption(45+binary.length,'finalized');
  const bufferRent=await c.getMinimumBalanceForRentExemption(37+binary.length,'finalized');
  const balance=await c.getBalance(authority,'finalized');
  console.log(JSON.stringify({network:'mainnet-beta',programId:expectedProgram,upgradeAuthority:expectedAuthority,protocol:protocol.toBase58(),binaryBytes:binary.length,binarySha256:manifest.binarySha256,programRentLamports:programRent,minimumProgramDataRentLamports:dataRent,bufferRentEstimateLamports:bufferRent,feePayerBalanceLamports:balance,warning:'Estimates only: allocation, transaction fees and temporary buffer funding may increase required SOL. No transaction sent.'},null,2));
  if(balance<programRent+dataRent) { console.warn('Funding below minimum final account rent estimate. Do not attempt deployment.'); if(process.env.GHOST_REQUIRE_FUNDED==='1') throw new Error('Insufficient estimated minimum rent funding'); }
}else{
  const [program,data,config]=await c.getMultipleAccountsInfo([pid,programData,protocol],'finalized');
  assert.ok(program?.executable && program.owner.equals(loader),'Expected executable loader-v3 program');
  assert.ok(program.data.length>=36 && program.data.readUInt32LE(0)===2,'Invalid program account state');
  assert.ok(new PublicKey(program.data.subarray(4,36)).equals(programData),'Wrong ProgramData address');
  assert.ok(data?.owner.equals(loader) && !data.executable,'Invalid ProgramData owner');
  const verified=verifyProgramData(data.data,binary);
  assert.ok(new PublicKey(verified.authorityBytes).equals(authority),'Upgrade authority differs');
  assert.equal(config,null,'Fresh locked release expects no initialized protocol config; inspect before proceeding');
  console.log(JSON.stringify({verified:true,network:'mainnet-beta',genesis,programId:pid.toBase58(),programData:programData.toBase58(),upgradeAuthority:authority.toBase58(),deploymentSlot:verified.deploymentSlot,allocatedBytes:verified.allocatedBytes,binarySha256:verified.binarySha256,protocol:protocol.toBase58(),protocolInitialized:false,marketExecution:false,privateSettlement:false,explorer:`https://explorer.solana.com/address/${pid.toBase58()}`},null,2));
}
