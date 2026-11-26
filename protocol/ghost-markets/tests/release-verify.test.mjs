import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, verifyProgramData, sha256 } from '../scripts/release-verify.mjs';
const bin=Buffer.from([0x7f,0x45,0x4c,0x46,1,2,3]);
const key='example-public-id';
const manifest={schema:1,release:'v27-locked-candidate',marketExecution:false,buildFeatures:'default',lockedLoopbackTest:'passed',programId:key,binarySha256:sha256(bin),binaryBytes:bin.length};
const account=()=>{const d=Buffer.alloc(45+bin.length+12);d.writeUInt32LE(3);d.writeBigUInt64LE(42n,4);d[12]=1;Buffer.alloc(32,5).copy(d,13);bin.copy(d,45);return d;};
test('locked release requires identity, default features, ELF and exact hash',()=>{
  checkRelease(manifest,bin,{address:key},key);
  for(const bad of [{...manifest,lockedLoopbackTest:'failed'},{...manifest,marketExecution:true},{...manifest,buildFeatures:'local-market-testing'},{...manifest,binaryBytes:1},{...manifest,programId:'wrong'},{...manifest,binarySha256:'0'.repeat(64)}]) assert.throws(()=>checkRelease(bad,bin,{address:key},key));
  assert.throws(()=>checkRelease(manifest,bin,{address:'wrong'},key));
});
test('byte verification allows only zero allocation padding',()=>{
  const d=account(); const info=verifyProgramData(d,bin);
  assert.equal(info.deploymentSlot,'42');assert.equal(info.binarySha256,sha256(bin));assert.equal(info.allocatedBytes,bin.length+12);assert.deepEqual(info.authorityBytes,Buffer.alloc(32,5));
  d[d.length-1]=1;assert.throws(()=>verifyProgramData(d,bin),/nonzero/);
});
test('wrong code, loader state, absent authority and truncation fail closed',()=>{
  const d=account();d[45]=0;assert.throws(()=>verifyProgramData(d,bin),/differ/);
  const wrong=account();wrong.writeUInt32LE(2);assert.throws(()=>verifyProgramData(wrong,bin),/loader-v3/);
  const immutable=account();immutable[12]=0;assert.throws(()=>verifyProgramData(immutable,bin),/retained/);
  assert.throws(()=>verifyProgramData(account().subarray(0,46),bin),/shorter/);
});
