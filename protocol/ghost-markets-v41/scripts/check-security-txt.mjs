/** Verify a single standard security.txt payload in the actual executable; no network. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const BEGIN=Buffer.from('=======BEGIN SECURITY.TXT V1=======\0');
const END=Buffer.from('=======END SECURITY.TXT V1=======\0');
export function checkSecurityTxt(binary){
 const data=Buffer.from(binary), start=data.indexOf(BEGIN);
 if(start<0||data.indexOf(BEGIN,start+BEGIN.length)>=0)throw new Error('Missing or duplicate Security.txt start');
 const end=data.indexOf(END,start+BEGIN.length);
 if(end<0||end-start>4096||data.indexOf(END,end+END.length)>=0)throw new Error('Missing, duplicate or excessive Security.txt end');
 const payload=data.subarray(start+BEGIN.length,end);
 if(!payload.length||payload.at(-1)!==0)throw new Error('Missing field terminator');
 const fields=new TextDecoder('utf-8',{fatal:true}).decode(payload).slice(0,-1).split('\0');
 if(fields.length%2)throw new Error('Invalid key/value pairing');
 const result=Object.create(null);
 for(let i=0;i<fields.length;i+=2){const k=fields[i],v=fields[i+1];if(!/^[a-z_]+$/.test(k)||!v||Object.hasOwn(result,k))throw new Error('Invalid Security.txt field');result[k]=v;}
 for(const [key,value] of Object.entries({name:'GHOST Markets',project_url:'https://privacycash.fun',contacts:'link:https://github.com/ghostrings/zolana/security',policy:'https://github.com/ghostrings/zolana/blob/main/SECURITY.md',source_code:'https://github.com/ghostrings/zolana',preferred_languages:'en'}))if(result[key]!==value)throw new Error(`Unexpected Security.txt field ${key}`);
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv.length!==3)throw new Error('Usage: node check-security-txt.mjs BINARY');console.log(JSON.stringify(checkSecurityTxt(readFileSync(process.argv[2])),null,2));}
