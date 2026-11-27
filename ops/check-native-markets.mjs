import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url)),out=mkdtempSync(resolve(tmpdir(),'ghost-markets-sdk-'));
try {
  writeFileSync(resolve(out,'package.json'),'{"type":"module"}\n');
  const local=resolve(root,'node_modules/typescript/bin/tsc'), args=['-p','tsconfig.native-markets-check.json','--outDir',out];
  const result=existsSync(local)?spawnSync(process.execPath,[local,...args],{cwd:root,stdio:'inherit'}):spawnSync(process.platform==='win32'?'tsc.cmd':'tsc',args,{cwd:root,stdio:'inherit',shell:process.platform==='win32'});
  if(result.status!==0)process.exitCode=result.status??1;
  else {const tests=spawnSync(process.execPath,['--test','tests/native-markets.node.mjs'],{cwd:root,stdio:'inherit',env:{...process.env,GHOST_MARKETS_SDK_BUILD:out}});process.exitCode=tests.status??1;}
} finally {rmSync(out,{recursive:true,force:true});}
