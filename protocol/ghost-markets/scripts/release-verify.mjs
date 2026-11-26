/** Pure release checks. No RPC and no signing. */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyProgramData(data, binary) {
  assert.ok(Buffer.isBuffer(data) && data.length >= 45, 'Invalid ProgramData account');
  assert.equal(data.readUInt32LE(0), 3, 'Not loader-v3 ProgramData');
  assert.equal(data[12], 1, 'Expected a retained upgrade authority');
  assert.ok(Buffer.isBuffer(binary) && binary.length > 0, 'Missing expected binary');
  assert.ok(data.length >= 45 + binary.length, 'On-chain program is shorter than expected');
  assert.ok(data.subarray(45, 45+binary.length).equals(binary), 'On-chain program bytes differ');
  assert.ok(data.subarray(45+binary.length).every(b=>b===0), 'Unexpected nonzero allocation tail');
  return { deploymentSlot: data.readBigUInt64LE(4).toString(), authorityBytes: data.subarray(13,45), binarySha256: sha256(binary), allocatedBytes: data.length-45 };
}
export function checkRelease(manifest, binary, idl, programId) {
  assert.equal(manifest.schema,1);
  assert.equal(manifest.release,'v27-locked-candidate');
  assert.equal(manifest.marketExecution,false);
  assert.equal(manifest.buildFeatures,'default');
  assert.equal(manifest.lockedLoopbackTest,'passed');
  assert.equal(manifest.programId,programId,'Program identity differs');
  assert.equal(idl.address,programId,'IDL identity differs');
  assert.equal(manifest.binarySha256,sha256(binary),'Binary hash differs');
  assert.equal(manifest.binaryBytes,binary.length,'Binary size differs');
  assert.ok(binary.length>4 && binary.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])),'Expected ELF binary');
}
