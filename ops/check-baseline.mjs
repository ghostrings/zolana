/** Release-specific check: no claims about behavior, cryptography or audits. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('evidence/v23-baseline.json', root), 'utf8'));
let failures = 0;
for (const [path, expected] of Object.entries(manifest.protected)) {
  try {
    const actual = createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex');
    if (actual !== expected) throw new Error('SHA-256 differs');
  } catch (error) { failures++; console.error(`${path}: ${error.message}`); }
}
console.log(`v23 baseline: ${Object.keys(manifest.protected).length - failures}/${Object.keys(manifest.protected).length} protected files match`);
if (failures) process.exitCode = 1;
