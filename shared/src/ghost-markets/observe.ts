/** V28 public-only observer. No wallet, signing, proof, or transaction submission API. */
export interface ReleaseIdentity { network: string; genesis: string; programId: string; programData: string; protocol: string; upgradeAuthority: string; deploymentSlot: string; binaryBytes: number; binarySha256: string; signature: string }
export const DEPLOYMENT: Readonly<ReleaseIdentity> = Object.freeze({
  network: 'mainnet-beta',
  genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  programId: '5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n',
  programData: 'J4iCsaLM24bBqjWGXvtB6N3LzUiJNJWwKAqLtXUzTXxt',
  protocol: '423vt8vZMJs5ToVjUtbHQFtXDVQ7AccAVHk7vh6P6vWK',
  upgradeAuthority: 'J4JRQza7JXnkct6kQC3roPYstoH2xFBoyQ5Wczpt5jPt',
  deploymentSlot: '474265505',
  binaryBytes: 533632,
  binarySha256: '2fba22c284791879f003aec3118c74fbd271f808f91b39e394e2654f9cc80d7d',
  signature: '5TMpEwE2XkjWTfY42XShQPks3UoYrVEDWiHFdAzcCXeJcZ1wnu6AXyEaXefQn3cx3geMixMHjKtziSe6vtXaANjT',
});
export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const MARKET_DISCRIMINATOR = 'dbbed53700e3c69a';
export const CONFIG_DISCRIMINATOR = 'cf5bfa1c98b3d7d1';
export const MARKET_BYTES = 563;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const U64_MAX = (1n << 64n) - 1n;
const requireThat = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
export function base58(bytes: Uint8Array): string {
  let n = 0n; for (const byte of bytes) n = n * 256n + BigInt(byte);
  let s = ''; while (n) { s = ALPHABET[Number(n % 58n)]! + s; n /= 58n; }
  for (const byte of bytes) { if (byte) break; s = '1' + s; }
  return s;
}
export function publicKey(value: string): Uint8Array {
  requireThat(typeof value === 'string' && value.length >= 32 && value.length <= 44, 'Invalid public address');
  let n = 0n; for (const char of value) { const digit = ALPHABET.indexOf(char); requireThat(digit >= 0, 'Invalid public address'); n = n * 58n + BigInt(digit); }
  const digits: number[] = []; while (n) { digits.unshift(Number(n % 256n)); n /= 256n; }
  for (const char of value) { if (char !== '1') break; digits.unshift(0); }
  const out = Uint8Array.from(digits);
  requireThat(out.length === 32 && base58(out) === value, 'Invalid public address'); return out;
}
export function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export async function digest(bytes: Uint8Array): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))); }
function record(x: unknown): Record<string, unknown> { requireThat(!!x && typeof x === 'object' && !Array.isArray(x), 'Malformed RPC object'); return x as Record<string, unknown>; }
function safeSlot(x: unknown): number { requireThat(typeof x === 'number' && Number.isSafeInteger(x) && x >= 0, 'Invalid RPC slot'); return x as number; }
function dataView(d: Uint8Array): DataView { return new DataView(d.buffer, d.byteOffset, d.byteLength); }
function bytesOf(raw: unknown, limit: number): Uint8Array {
  requireThat(Array.isArray(raw) && raw.length === 2 && raw[1] === 'base64' && typeof raw[0] === 'string', 'Expected base64 account bytes');
  const text = (raw as [string, string])[0];
  requireThat(text.length <= Math.ceil(limit / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(text), 'Account data exceeds bound or is malformed');
  const bytes = Uint8Array.from(atob(text), x => x.charCodeAt(0)); requireThat(bytes.length <= limit, 'Account data exceeds bound'); return bytes;
}
function account(raw: unknown, owner: string, executable: boolean, limit: number): Uint8Array {
  const a = record(raw); requireThat(a.owner === owner && a.executable === executable, 'Unexpected account owner or executable flag'); return bytesOf(a.data, limit);
}
function addressAt(d: Uint8Array, offset: number): string { requireThat(offset + 32 <= d.length, 'Truncated account'); return base58(d.subarray(offset, offset + 32)); }
function context(raw: unknown): {slot: number; value: unknown} { const r = record(raw); return {slot: safeSlot(record(r.context).slot), value: r.value}; }
export type ReadMethod = 'getGenesisHash' | 'getMultipleAccounts' | 'getAccountInfo' | 'getProgramAccounts' | 'getSignaturesForAddress';
export type RpcRead = (method: ReadMethod, params?: readonly unknown[]) => Promise<unknown>;
const READ_METHODS = new Set<string>(['getGenesisHash','getMultipleAccounts','getAccountInfo','getProgramAccounts','getSignaturesForAddress']);
/** For CLI use only trusted HTTPS RPCs; browser uses the site's own relay. Never accepts arbitrary methods. */
export function createReadRpc(endpoint: string, request: typeof fetch = fetch): RpcRead {
  const url = new URL(endpoint);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireThat(!url.username && !url.password && !url.hash && (url.protocol === 'https:' || (loopback && url.protocol === 'http:')), 'Use HTTPS or local loopback');
  let id = 0;
  return async (method, params = []) => {
    requireThat(READ_METHODS.has(method), 'Read-only RPC: method refused');
    const requestId = ++id;
    const response = await request(url.href, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}), redirect:'error', signal:AbortSignal.timeout(30_000)});
    requireThat(response.ok, 'RPC unavailable');
    // Read at most 8 MiB. Public scans are explicit CLI operations, not browser polling.
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing RPC body');
    const decoder = new TextDecoder(); let body = '', length = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 8*1024*1024) throw new Error('RPC response too large'); body += decoder.decode(part.value,{stream:true}); } body += decoder.decode(); }
    finally { await reader.cancel().catch(()=>{}); }
    const result = record(JSON.parse(body));
    requireThat(result.jsonrpc === '2.0' && result.id === requestId && !result.error && 'result' in result, 'RPC rejected request or returned invalid response'); return result.result;
  };
}
export interface ProtocolState { mode: 'locked' | 'active' | 'paused'; admin: string; pauser: string; pendingAdmin: string }
export function decodeProtocol(raw: unknown, programId = DEPLOYMENT.programId): ProtocolState | null {
  if (raw === null) return null;
  const d = account(raw, programId, false, 107);
  requireThat(d.length === 107 && hex(d.subarray(0,8)) === CONFIG_DISCRIMINATOR && d[8] === 1, 'Unexpected protocol account schema');
  const mode = (['locked','active','paused'] as const)[d[10]!]; if (!mode) throw new Error('Unknown protocol mode');
  return {mode,admin:addressAt(d,11),pauser:addressAt(d,43),pendingAdmin:addressAt(d,75)};
}
export interface DeploymentObservation { source: 'finalized-rpc'; observedAt: string; slot: number; programId: string; programData: string; binarySha256: string; deploymentSlot: string; upgradeAuthority: string; protocol: ProtocolState | null; marketExecution: false; privateSettlement: false; }
/** The exact recorded release only. Any changed binary, slot, authority or non-locked config fails closed. */
export async function observeDeployment(rpc: RpcRead): Promise<DeploymentObservation> {
  return {...await verifyReleaseSnapshot(rpc, DEPLOYMENT), marketExecution:false, privateSettlement:false};
}
/** Pure comparison against a caller-supplied release identity for offline tests or other release records.
 * The application always uses observeDeployment and its pinned mainnet record. */
export async function verifyReleaseSnapshot(rpc: RpcRead, expected: Readonly<ReleaseIdentity>): Promise<Omit<DeploymentObservation, 'marketExecution' | 'privateSettlement'>> {
  requireThat(await rpc('getGenesisHash') === expected.genesis, 'Wrong network: expected mainnet-beta');
  const observed = context(await rpc('getMultipleAccounts', [[expected.programId, expected.programData, expected.protocol], {encoding:'base64',commitment:'finalized'}]));
  requireThat(Array.isArray(observed.value) && observed.value.length === 3 && BigInt(observed.slot) >= BigInt(expected.deploymentSlot), 'Invalid or stale finalized snapshot');
  const [p, pd, config] = observed.value as unknown[];
  const program = account(p, LOADER, true, 36);
  requireThat(program.length === 36 && dataView(program).getUint32(0,true) === 2 && addressAt(program,4) === expected.programData, 'Unexpected ProgramData pointer');
  const data = account(pd, LOADER, false, 45 + expected.binaryBytes);
  requireThat(data.length === 45 + expected.binaryBytes && dataView(data).getUint32(0,true) === 3 && data[12] === 1, 'Unexpected ProgramData layout or size');
  const slot = dataView(data).getBigUint64(4,true).toString(), authority = addressAt(data,13);
  requireThat(slot === expected.deploymentSlot && authority === expected.upgradeAuthority, 'Deployment slot or authority changed; review required');
  const sha = await digest(data.subarray(45));
  requireThat(sha === expected.binarySha256, 'Deployed binary changed; review required');
  const protocol = decodeProtocol(config, expected.programId); requireThat(protocol === null || protocol.mode === 'locked', 'Unexpected protocol mode; review required');
  return {source:'finalized-rpc', observedAt:new Date().toISOString(), slot:observed.slot,programId:expected.programId,programData:expected.programData,binarySha256:sha,deploymentSlot:slot,upgradeAuthority:authority,protocol};
}
export interface PublicMarket { address:string; creator:string; nonce:string; phase:'curve'|'ready'|'pool'; baseMint:string; quoteMint:string; lpMint:string; baseVault:string; quoteVault:string; lpLock:string; version:string; baseReserve:string; quoteReserve:string; virtualQuote:string; graduationQuote:string; feeBps:number; initialSupply:string; burnedAtGraduation:string; lockedLp:string; name:string; symbol:string; metadataUri:string }
/** Only public account state, exact integers in base units, never a holder-ownership inference. */
export function decodeMarket(address: string, raw: unknown): PublicMarket {
  publicKey(address);
  const d = account(raw, DEPLOYMENT.programId, false, MARKET_BYTES);
  requireThat(d.length === MARKET_BYTES && hex(d.subarray(0,8)) === MARKET_DISCRIMINATOR && d[8] === 1, 'Unexpected market account schema');
  const view = dataView(d), phase = (['curve','ready','pool'] as const)[d[10]!]; if (!phase) throw new Error('Unknown market phase');
  const value = (offset:number) => view.getBigUint64(offset,true).toString();
  const feeBps = view.getUint16(283,true); requireThat(feeBps <= 100, 'Unexpected market fee');
  let off = 309;
  const text = (max:number):string => { requireThat(off+4<=d.length,'Truncated metadata'); const len=view.getUint32(off,true); off+=4; requireThat(len<=max && off+len<=d.length,'Invalid metadata length'); const val=new TextDecoder('utf-8',{fatal:true}).decode(d.subarray(off,off+len)); off+=len; return val; };
  const name=text(32), symbol=text(10), metadataUri=text(200);
  return {address,creator:addressAt(d,11),nonce:value(43),phase,baseMint:addressAt(d,51),quoteMint:addressAt(d,83),lpMint:addressAt(d,115),baseVault:addressAt(d,147),quoteVault:addressAt(d,179),lpLock:addressAt(d,211),version:value(243),baseReserve:value(251),quoteReserve:value(259),virtualQuote:value(267),graduationQuote:value(275),feeBps,initialSupply:value(285),burnedAtGraduation:value(293),lockedLp:value(301),name,symbol,metadataUri};
}
/** Independent inspection of a public account; no private wallet address or balance reads. */
export async function lookupMarket(rpc:RpcRead,address:string):Promise<{slot:number;market:PublicMarket|null}> {
  publicKey(address); requireThat(await rpc('getGenesisHash')===DEPLOYMENT.genesis,'Wrong network');
  const result=context(await rpc('getAccountInfo',[address,{encoding:'base64',commitment:'finalized'}]));
  return {slot:result.slot,market:result.value===null?null:decodeMarket(address,result.value)};
}
/** Explicit CLI snapshot only. RPC may refuse program scans; report failure, never a fabricated empty index. */
export async function discoverMarkets(rpc:RpcRead):Promise<{source:'finalized-rpc-scan';slot:number;markets:PublicMarket[]}> {
  requireThat(await rpc('getGenesisHash')===DEPLOYMENT.genesis,'Wrong network');
  const result=context(await rpc('getProgramAccounts',[DEPLOYMENT.programId,{encoding:'base64',commitment:'finalized',withContext:true,filters:[{dataSize:MARKET_BYTES},{memcmp:{offset:0,bytes:base58(Uint8Array.from(MARKET_DISCRIMINATOR.match(/../g)!.map(x=>parseInt(x,16))))}}]}]));
  requireThat(Array.isArray(result.value)&&result.value.length<=5000,'Scan refused or exceeds snapshot limit');
  const seen = new Set<string>(); const markets = (result.value as unknown[]).map(item=>{const a=record(item);requireThat(typeof a.pubkey==='string'&&!seen.has(a.pubkey),'Invalid or duplicate market address');const id=a.pubkey as string;seen.add(id);return decodeMarket(id,a.account);});
  return {source:'finalized-rpc-scan',slot:result.slot,markets:markets.sort((a,b)=>a.address<b.address?-1:a.address>b.address?1:0)};
}
export async function recentActivity(rpc:RpcRead):Promise<{signature:string;slot:number;failed:boolean}[]> {
  requireThat(await rpc('getGenesisHash')===DEPLOYMENT.genesis,'Wrong network');
  const r=await rpc('getSignaturesForAddress',[DEPLOYMENT.programId,{limit:10,commitment:'finalized'}]);requireThat(Array.isArray(r)&&r.length<=10,'Invalid history result');
  return (r as unknown[]).map(x=>{const a=record(x);requireThat(typeof a.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(a.signature)&&'err' in a,'Invalid history entry');return {signature:a.signature as string,slot:safeSlot(a.slot),failed:a.err!==null};});
}
export function positiveU64(v: bigint): bigint { requireThat(typeof v==='bigint'&&v>0n&&v<=U64_MAX,'Expected positive u64 base units'); return v; }
