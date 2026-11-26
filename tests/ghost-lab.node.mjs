import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.GHOST_TEST_BUILD;
if (!root) throw new Error('Run npm run ghost:check.');
const { GHOST_RING_TARGET, ghostRingStatus } = await import(pathToFileURL(resolve(root, 'config.js')).href);
const { GhostRingLab, LAB_MEMBERS, LAB_ASSETS } = await import(pathToFileURL(resolve(root, 'lab.js')).href);
const { labAggregate } = await import(pathToFileURL(resolve(root, 'intelligence.js')).href);
const approval = { ownerApproved: true, cosignerApproved: true };
const move = (overrides = {}) => ({ operation: 'transfer', member: 'TEST-01', recipient: 'TEST-02', asset: 'TEST-SOL', amount: 10n, ...overrides });
const deposit = (overrides = {}) => ({ operation: 'deposit', member: 'TEST-01', asset: 'TEST-SOL', amount: 10n, ...overrides });
const withdraw = (overrides = {}) => ({ operation: 'withdraw', member: 'TEST-01', asset: 'TEST-SOL', amount: 10n, ...overrides });
const both = (lab, asset = 'TEST-SOL') => LAB_MEMBERS.map((m) => lab.balance(m, asset));
const rejected = (lab, legs, a = approval) => {
  const before = LAB_ASSETS.map((asset) => both(lab, asset));
  const receipt = lab.execute(legs, a);
  assert.equal(receipt.result, 'rejected');
  assert.deepEqual(LAB_ASSETS.map((asset) => both(lab, asset)), before);
  return receipt;
};
const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('exact research target matches the user-specified JSON, and cannot enable network execution', () => {
  const expected = { name: 'GHOST Trading Ring v1', environment: 'devnet-research', privacy: 'anonymous', assets: 'all', membership: 'open', blocklist: true, freeze: true, cosigning: true, auditor: true, pause: true, permanentDelegate: false };
  assert.deepEqual(GHOST_RING_TARGET, expected);
  assert.deepEqual(JSON.parse(file('config/ghost-ring.research.json')), expected);
  assert.equal(Object.isFrozen(GHOST_RING_TARGET), true);
  assert.equal(ghostRingStatus().execution, 'local-simulation-only');
  assert.equal(ghostRingStatus().canTransact, false);
  assert.equal(ghostRingStatus().auditedAnalytics, false);
  assert.equal(ghostRingStatus().network, null);
  assert.equal(ghostRingStatus().ringProgram, null);
});
test('transfer requires no allowlist and preserves both supply and ring total', () => {
  const lab = new GhostRingLab(); const snapshot = lab.snapshot('TEST-SOL');
  const a = lab.balance('TEST-01', 'TEST-SOL'), b = lab.balance('TEST-02', 'TEST-SOL');
  assert.equal(lab.execute([move()], approval).result, 'accepted');
  assert.equal(lab.balance('TEST-01', 'TEST-SOL').ring, a.ring - 10n);
  assert.equal(lab.balance('TEST-02', 'TEST-SOL').ring, b.ring + 10n);
  assert.equal(lab.snapshot('TEST-SOL').totalSupply, snapshot.totalSupply);
  assert.equal(labAggregate(lab.snapshot('TEST-SOL')).ringUnits, labAggregate(snapshot).ringUnits);
});
test('deposit and withdrawal conserve synthetic asset supply, and change ring totals exactly', () => {
  const lab = new GhostRingLab(); const before = lab.balance('TEST-01', 'TEST-SOL'); const supply = lab.snapshot('TEST-SOL').totalSupply;
  assert.equal(lab.execute([deposit()], approval).result, 'accepted');
  assert.deepEqual(lab.balance('TEST-01', 'TEST-SOL'), { ring: before.ring + 10n, outside: before.outside - 10n });
  assert.equal(lab.execute([withdraw()], approval).result, 'accepted');
  assert.deepEqual(lab.balance('TEST-01', 'TEST-SOL'), before);
  assert.equal(lab.snapshot('TEST-SOL').totalSupply, supply);
});
test('pause rejects every operation without mutating balances, resume restores simulation', () => {
  const lab = new GhostRingLab(); lab.setPaused(true);
  for (const leg of [move(), deposit(), withdraw()]) assert.match(rejected(lab, [leg]).reason, /paused/);
  lab.setPaused(false); assert.equal(lab.execute([move()], approval).result, 'accepted');
});
test('blocklist prevents simulated incoming transfers and deposits, removing it allows receipt', () => {
  const lab = new GhostRingLab(); lab.setBlocked('TEST-02', true);
  assert.match(rejected(lab, [move()]).reason, /blocklisted/);
  assert.match(rejected(lab, [deposit({ member: 'TEST-02' })]).reason, /blocklisted/);
  lab.setBlocked('TEST-02', false); assert.equal(lab.execute([move()], approval).result, 'accepted');
});
test('freeze prevents spending but permits incoming assets under the lab model', () => {
  const lab = new GhostRingLab(); lab.setFrozen('TEST-01', true);
  assert.match(rejected(lab, [move()]).reason, /frozen/);
  assert.match(rejected(lab, [withdraw()]).reason, /frozen/);
  assert.equal(lab.execute([move({ member: 'TEST-02', recipient: 'TEST-01' })], approval).result, 'accepted');
  assert.equal(lab.execute([deposit()], approval).result, 'accepted');
});
test('both simulated owner and co-signer approvals are required for every operation', () => {
  const lab = new GhostRingLab();
  for (const leg of [move(), deposit(), withdraw()]) {
    assert.match(rejected(lab, [leg], { ...approval, ownerApproved: false }).reason, /owner/);
    assert.match(rejected(lab, [leg], { ...approval, cosignerApproved: false }).reason, /co-signer/);
    rejected(lab, [leg], { ownerApproved: 'yes', cosignerApproved: true });
  }
});
test('valid two-leg fill commits atomically and preserves each asset supply', () => {
  const lab = new GhostRingLab();
  const other = move({ member: 'TEST-02', recipient: 'TEST-01', asset: 'TEST-TOKEN', amount: 25n });
  const supplies = LAB_ASSETS.map((asset) => lab.snapshot(asset).totalSupply);
  assert.equal(lab.execute([move(), other], approval).result, 'accepted');
  assert.equal(lab.balance('TEST-01', 'TEST-SOL').ring, 90n);
  assert.equal(lab.balance('TEST-01', 'TEST-TOKEN').ring, 1025n);
  assert.deepEqual(LAB_ASSETS.map((asset) => lab.snapshot(asset).totalSupply), supplies);
});
test('failing second leg leaves the first leg untouched', () => {
  const lab = new GhostRingLab();
  const other = move({ member: 'TEST-02', recipient: 'TEST-01', asset: 'TEST-TOKEN', amount: 1000000n });
  assert.match(rejected(lab, [move(), other]).reason, /Insufficient/);
  lab.setFrozen('TEST-02', true);
  assert.match(rejected(lab, [move(), { ...other, amount: 25n }]).reason, /frozen/);
});
test('malformed batches, invalid amounts, self-transfers and non-fictional addresses or mints are refused', () => {
  const lab = new GhostRingLab();
  for (const legs of [[], [move(), move()], [move(), deposit()], [move(), move(), move()], [move({ amount: -1n })], [move({ amount: 0n })], [move({ amount: 1000001n })], [move({ amount: 1 })], [move({ recipient: 'TEST-01' })], [move({ asset: 'SOL' })], [move({ member: '11111111111111111111111111111111' })], [move({ operation: 'delegate' })], [deposit({ recipient: 'TEST-02' })]]) rejected(lab, legs);
  assert.throws(() => lab.setBlocked('real-address', true));
  assert.throws(() => lab.balance('TEST-01', 'SOL'));
});
test('aggregates use exact integer math, report no per-participant data or creator inference', () => {
  const lab = new GhostRingLab(); const s = lab.snapshot('TEST-SOL'); const report = labAggregate(s);
  assert.equal(report.holderCount, 12);
  assert.equal(report.source, 'synthetic-local');
  assert.equal(report.ringUnits, '1266');
  assert.equal(report.totalSupplyUnits, '7266');
  assert.equal(report.ringShareBps, Number(1266n * 10000n / 7266n));
  assert.equal(report.topTenShareBps, Number(1065n * 10000n / 1266n));
  assert.equal(report.declaredCreatorShareBps, null);
  assert.equal(JSON.stringify(report).includes('TEST-01'), false);
  assert.equal('balances' in report, false);
});
test('small groups suppress holder count and concentration', () => {
  const lab = new GhostRingLab(); assert.equal(lab.execute([withdraw({ amount: 100n })], approval).result, 'accepted');
  const report = labAggregate(lab.snapshot('TEST-SOL'));
  assert.equal(report.holderCount, null); assert.equal(report.topTenShareBps, null);
});
test('malformed or over-supply synthetic snapshots are refused', () => {
  const s = new GhostRingLab().snapshot('TEST-SOL');
  for (const bad of [{ ...s, source: 'mainnet' }, { ...s, totalSupply: 1n }, { ...s, balances: [-1n] }, { ...s, totalSupply: 0n }, { ...s, sequence: -1 }, { ...s, balances: new Array(13).fill(1n) }]) assert.throws(() => labAggregate(bad));
});
test('receipts do not expose amounts or owners, and are bounded and copied', () => {
  const lab = new GhostRingLab();
  for (let i = 0; i < 60; i++) lab.execute([move()], { ownerApproved: false, cosignerApproved: false });
  assert.equal(lab.receipts().length, 50);
  assert.equal(lab.receipts()[0].sequence, 11);
  const copy = lab.receipts(); copy[0].reason = 'changed'; assert.notEqual(lab.receipts()[0].reason, 'changed');
  assert.doesNotMatch(JSON.stringify(lab.receipts()), /TEST-01|TEST-SOL|"amount"/);
});
test('new routes and pages are wired while transaction features fail closed', () => {
  const server = file('server/src/index.ts'); const router = file('server/src/custom-rings/routes.ts');
  assert.match(server, /api\.use\('\/custom-rings', customRingsRouter\(\)\)/);
  assert.match(router, /router\.get\('\/status'/);
  assert.match(router, /response\.status\(403\)/);
  assert.doesNotMatch(router, /router\.(post|put|patch|delete)\(/);
  const vite = file('web/vite.config.ts'); assert.match(vite, /ghost\.html/); assert.match(vite, /ghost-intelligence\.html/);
  const lab = file('web/src/pages/ghost.ts'); assert.doesNotMatch(lab, /from ['"].*(wallet|trade|privacy|chain|signing|keyring)\.js['"]/);
  for (const path of ['web/index.html', 'web/create.html', 'web/wallet.html', 'web/token.html', 'web/partials/header.html']) assert.match(file(path), /\/ghost/);
  for (const [html, script] of [['web/ghost.html', 'web/src/pages/ghost.ts'], ['web/ghost-intelligence.html', 'web/src/pages/ghost-intelligence.ts']]) {
    const markup = file(html); const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const match of file(script).matchAll(/['"]((?:ghost|gi)-[a-z][a-z0-9-]+)['"]/g)) {
      if (['ghost-receipt'].includes(match[1])) continue;
      assert.ok(ids.includes(match[1]), `${script}: missing id ${match[1]}`);
    }
  }
});

test('synthetic snapshots require exactly the fixed participant set and dense bigint entries', () => {
  const s = new GhostRingLab().snapshot('TEST-SOL');
  for (const balances of [[], [1n], new Array(12), [...s.balances.slice(0, 11), undefined], [...s.balances.slice(0, 11), 1]]) {
    assert.throws(() => labAggregate({ ...s, balances }), /Invalid synthetic snapshot/);
  }
});

test('deterministic state-machine stress test preserves balances and rollback across 2,000 operations', () => {
  const lab = new GhostRingLab();
  // Fixed-seed, reproducible generator; not cryptographic randomness or fuzz coverage.
  let seed = 0x47484f53;
  const rand = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % limit; };
  const supplies = LAB_ASSETS.map((asset) => lab.snapshot(asset).totalSupply);
  let accepted = 0, rejectedCount = 0, fills = 0;
  for (let i = 0; i < 2000; i++) {
    const m = rand(LAB_MEMBERS.length), n = (m + 1 + rand(LAB_MEMBERS.length - 1)) % LAB_MEMBERS.length;
    const a = LAB_MEMBERS[m], b = LAB_MEMBERS[n], assetIndex = rand(2);
    const asset = LAB_ASSETS[assetIndex], otherAsset = LAB_ASSETS[1 - assetIndex];
    lab.setPaused(rand(12) === 0); lab.setBlocked(b, rand(5) === 0); lab.setFrozen(a, rand(5) === 0);
    const type = rand(4), amount = BigInt(1 + rand(800));
    const leg = { operation: type === 0 ? 'deposit' : type === 1 ? 'withdraw' : 'transfer', member: a, asset, amount, ...(type >= 2 ? { recipient: b } : {}) };
    const legs = type === 3 ? [leg, { operation: 'transfer', member: b, recipient: a, asset: otherAsset, amount: BigInt(1 + rand(800)) }] : [leg];
    const before = LAB_ASSETS.map((a) => both(lab, a));
    const receipt = lab.execute(legs, { ownerApproved: rand(8) !== 0, cosignerApproved: rand(8) !== 0 });
    assert.equal(receipt.sequence, i + 1);
    if (receipt.result === 'rejected') {
      rejectedCount++; assert.deepEqual(LAB_ASSETS.map((a) => both(lab, a)), before);
    } else { accepted++; if (type === 3) fills++; }
    for (const [j, asset] of LAB_ASSETS.entries()) {
      const balances = both(lab, asset);
      assert.ok(balances.every(({ ring, outside }) => ring >= 0n && outside >= 0n));
      assert.equal(balances.reduce((sum, { ring, outside }) => sum + ring + outside, 0n), supplies[j]);
      assert.equal(lab.snapshot(asset).totalSupply, supplies[j]);
      const aggregate = labAggregate(lab.snapshot(asset));
      assert.ok(aggregate.ringShareBps >= 0 && aggregate.ringShareBps <= 10000);
      assert.ok(aggregate.topTenShareBps === null || aggregate.topTenShareBps <= 10000);
    }
  }
  assert.ok(accepted > 0 && rejectedCount > 0 && fills > 0, `accepted=${accepted}, rejected=${rejectedCount}, fills=${fills}`);
  assert.equal(lab.receipts().length, 50);
});
