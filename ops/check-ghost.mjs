/** Dependency-free test runner if a compatible TypeScript compiler is already installed. */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const demo = process.argv[2] === '--demo';
if (process.argv.length > (demo ? 3 : 2)) throw new Error('Use ghost:check or ghost:demo.');
const out = mkdtempSync(resolve(tmpdir(), 'ghost-check-'));
try {
  writeFileSync(resolve(out, 'package.json'), '{"type":"module"}\n');
  const local = resolve(root, 'node_modules/typescript/bin/tsc');
  const compileArgs = ['-p', 'tsconfig.ghost-check.json', '--outDir', out];
  const compile = existsSync(local)
    ? spawnSync(process.execPath, [local, ...compileArgs], { cwd: root, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'tsc.cmd' : 'tsc', compileArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (compile.error || compile.status !== 0) {
    console.error('GHOST check requires a compatible TypeScript compiler (npm ci pins 5.9.x).', compile.error?.message ?? '');
    process.exitCode = compile.status ?? 1;
  } else {
    const tests = spawnSync(process.execPath, demo ? ['examples/ghost-policy-demo.mjs'] : ['--test', 'tests/ghost-lab.node.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, GHOST_TEST_BUILD: out } });
    process.exitCode = tests.status ?? 1;
  }
} finally { rmSync(out, { recursive: true, force: true }); }
