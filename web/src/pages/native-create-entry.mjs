import {inspectNativeRelease} from '../../../shared/src/ghost-markets/v33-release.ts';
import {createReadRpc} from '../../../shared/src/ghost-markets/observe.ts';
if(new URL(location.href).searchParams.get('rail')==='native'){
 let v41=false;
 try{const o=await inspectNativeRelease(createReadRpc(location.origin+'/api/helius'));v41=o.release==='v41';}catch{/* fail closed in legacy signing guard */}
 if(v41){const {mountV41Create}=await import('./native-create-v41.mjs');mountV41Create();}
 else{const {mountNativeCreate}=await import('./native-create.mjs');mountNativeCreate();}
}
