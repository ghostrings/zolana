import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {Keypair,PublicKey,SystemProgram,SystemInstruction,Transaction,ComputeBudgetProgram} from '@solana/web3.js';
import {V33} from '../shared/src/ghost-markets/v33-release.ts';
import {launchSpec,canonicalLaunch,inspectLaunch,packLaunch,launchNonceAddress,LIVE_SLOT} from '../web/src/native-v33/launch-nonce-envelope.mjs';
const creator=Keypair.generate(),id=creator.publicKey.toBase58(),nonce={nonceValue:Keypair.generate().publicKey.toBase58(),nonceSlot:474350901},values={creator:id,name:'Owner Pilot',symbol:'PILOT',feeBps:300,nonce:'42'};
const idl=JSON.parse(readFileSync('deployments/mainnet/v33-release/ghost_markets.json','utf8'));
const wire=t=>t.serialize({requireAllSignatures:false,verifySignatures:false});
test('exact durable nonce launch: pinned executable, two signers, create only and all three fee tiers',async()=>{
 for(const feeBps of [200,300,400]){
  const s=await launchSpec({...values,feeBps},nonce),v=await canonicalLaunch(s),t=Transaction.from(v.unsigned);
  assert.equal(s.deploymentSlot,LIVE_SLOT);assert.equal(t.recentBlockhash,nonce.nonceValue);assert.deepEqual(v.signers,[id,V33.admin]);assert.equal(t.feePayer.toBase58(),id);assert.equal(t.instructions.length,3);
  const advance=SystemInstruction.decodeNonceAdvance(t.instructions[0]);assert.ok(advance.noncePubkey.equals(await launchNonceAddress()));assert.equal(advance.authorizedPubkey.toBase58(),V33.admin);assert.ok(t.instructions[1].programId.equals(ComputeBudgetProgram.programId));
  const launch=t.instructions[2],create=idl.instructions.find(i=>i.name==='create_market');assert.equal(launch.programId.toBase58(),V33.programId);assert.deepEqual([...launch.data.subarray(0,8)],create.discriminator);assert.equal(launch.data.readUInt16LE(launch.data.length-2),feeBps);assert.equal(launch.keys.length,create.accounts.length+1);assert.equal(launch.keys.at(-1).pubkey.toBase58(),V33.admin);assert.ok(launch.keys.at(-1).isSigner);assert.equal(v.summary.creatorPremint,0);assert.equal(v.summary.initialBuy,false);assert.equal(v.summary.privateSettlement,false);assert.equal(v.summary.assetRegistrationIncluded,false);
 }
});
test('creator signs canonical launch; unrelated or forged signatures and mutated intent refused',async()=>{
 const s=await launchSpec(values,nonce),v=await canonicalLaunch(s);v.tx.partialSign(creator);const w=wire(v.tx);const checked=await inspectLaunch(packLaunch(s,w));assert.deepEqual(checked.signed,[id]);assert.equal(checked.summary.mint,v.summary.mint);
 await assert.rejects(()=>inspectLaunch(packLaunch({...s,feeBps:400},w)),/canonical/);
 await assert.rejects(()=>inspectLaunch(packLaunch({...s,deploymentSlot:'1'},w)),/identity/);
 await assert.rejects(()=>inspectLaunch(packLaunch({...s,nonceAccount:Keypair.generate().publicKey.toBase58()},w)),/identity/);
 await assert.rejects(()=>inspectLaunch(packLaunch({...s,extra:true},w)),/fields/);
 const forged=Uint8Array.from(v.unsigned);forged[1]=1;await assert.rejects(()=>inspectLaunch(packLaunch(s,forged)),/signature/i);
});
test('refuse appended fund transfer or altered transaction',async()=>{
 const s=await launchSpec(values,nonce),v=await canonicalLaunch(s),t=Transaction.from(v.unsigned);t.add(SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));await assert.rejects(()=>inspectLaunch(packLaunch(s,wire(t))),/canonical/);
});
test('creator roles, metadata and nonce range are checked',async()=>{
 for(const change of [{creator:V33.admin},{creator:V33.treasury},{creator:V33.pauser},{symbol:'lower'},{feeBps:100},{nonce:'18446744073709551616'}])await assert.rejects(()=>launchSpec({...values,...change},nonce));
});
