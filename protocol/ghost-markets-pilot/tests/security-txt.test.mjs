import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {checkSecurityTxt} from '../scripts/check-security-txt.mjs';
const fields={name:'GHOST Markets',project_url:'https://privacycash.fun',contacts:'link:https://github.com/ghostrings/zolana/security',policy:'https://github.com/ghostrings/zolana/blob/main/SECURITY.md',source_code:'https://github.com/ghostrings/zolana',preferred_languages:'en'};
const start='=======BEGIN SECURITY.TXT V1=======\0',end='=======END SECURITY.TXT V1=======\0';
const payload=Object.entries(fields).flat().join('\0')+'\0';
const valid=Buffer.from('prefix'+start+payload+end+'suffix');
test('security metadata payload recognizes expected project and contact',()=>assert.deepEqual({...checkSecurityTxt(valid)},fields));
test('missing, truncated, duplicate or wrong metadata fails closed',()=>{for(const b of [Buffer.from('empty'),Buffer.from(start+payload),Buffer.concat([valid,valid]),Buffer.from(start+payload.replace('GHOST Markets','Other')+end),Buffer.from(start+payload+'name\0duplicate\0'+end),Buffer.from(start+payload.slice(0,-1)+end)])assert.throws(()=>checkSecurityTxt(b));});
test('compiled source declares intended metadata and gates the macro for libraries',()=>{const rust=readFileSync(new URL('../programs/ghost-markets/src/lib.rs',import.meta.url),'utf8');assert.match(rust,/#\[cfg\(not\(feature = "no-entrypoint"\)\)\]\s*solana_security_txt::security_txt!/);for(const [k,v]of Object.entries(fields))assert.ok(rust.includes(`${k}: "${v}"`));});
