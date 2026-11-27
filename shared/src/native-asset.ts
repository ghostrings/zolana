/** Verify a native market's actual mint and Privacy Rings interface using the pinned SDK.
 * No proof requests, wallet keys, private balances or transaction signing.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { address } from '@solana/kit';
import { getProtocolConfigAddress, getSplAssetRegistryAddress } from '@heliuslabs/spr/addresses';
import { decodeProtocolConfig, decodeSplAssetRegistry } from '@heliuslabs/spr/interface';
import { SPP_PROGRAM_ID } from './constants.js';
import { V33 } from './ghost-markets/v33-release.js';
import { nativeAssetState, type AssetFacts, type NativeAssetState } from './ghost-markets/asset-state.js';
export interface AssetReadiness { state:NativeAssetState; mint:string; registry:string; slot:number; assetId:string|null; config:AssetFacts['config'] }
export async function readNativeAsset(connection:Connection,mintAddress:string,minContextSlot?:number):Promise<AssetReadiness> {
  if(await connection.getGenesisHash()!==V33.genesis)throw Error('Wrong network');
  const mint=new PublicKey(mintAddress);
  const registry=new PublicKey(await getSplAssetRegistryAddress(address(mint.toBase58()))),protocol=new PublicKey(await getProtocolConfigAddress());
  const result=await connection.getMultipleAccountsInfoAndContext([mint,registry,protocol],{commitment:'finalized',...(minContextSlot===undefined?{}:{minContextSlot})});
  const [mi,ri,pi]=result.value;
  let mintValid=false,assetId:string|null=null,registryStatus:AssetFacts['registry']='invalid',config:AssetFacts['config']='unknown';
  try {const m=unpackMint(mint,mi??null,TOKEN_PROGRAM_ID);mintValid=m.isInitialized&&m.decimals===6&&m.mintAuthority===null&&m.freezeAuthority===null&&m.supply<=BigInt(V33.supply);}catch{/* unavailable */}
  if(ri===null)registryStatus='absent';
  else if(ri&&ri.owner.toBase58()===SPP_PROGRAM_ID&&!ri.executable){try{const decoded=decodeSplAssetRegistry(new Uint8Array(ri.data));if(String(decoded.mint)===mint.toBase58()&&decoded.assetId>0n){registryStatus='valid';assetId=String(decoded.assetId);}}catch{/* malformed */}}
  if(pi&&pi.owner.toBase58()===SPP_PROGRAM_ID&&!pi.executable){try{const p=decodeProtocolConfig(pi.data);if(typeof p.splInterfaceCreationIsPermissionless==='boolean')config=p.splInterfaceCreationIsPermissionless?'open':'restricted';}catch{/* unavailable */}}
  const state=nativeAssetState({mintValid,registry:registryStatus,config});
  return {state,mint:mint.toBase58(),registry:registry.toBase58(),slot:result.context.slot,assetId:state==='registered'?assetId:null,config};
}
