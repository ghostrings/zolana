/** Public status only. Never imports a signer, wallet or transaction builder. */
import { parseNativeDisplay, nativeDisplaySummary, type DisplayStatus } from '../../shared/src/ghost-markets/native-display.js';
import './native-markets.css';
export async function readNativeStatus(): Promise<DisplayStatus|null> {
  try {
    const response=await fetch('/api/ghost-markets/v33/status',{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(120_000)});
    return response.ok?parseNativeDisplay(await response.json()):null;
  }catch{return null;}
}
export const nativeSummary=nativeDisplaySummary;
export async function mountNativeSummary():Promise<void>{
  const nodes=document.querySelectorAll<HTMLElement>('[data-native-summary]');
  if(!nodes.length)return;
  const state=await readNativeStatus();nodes.forEach(node=>{node.textContent=nativeSummary(state);});
}
