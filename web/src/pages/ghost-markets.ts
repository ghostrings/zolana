import { DEPLOYMENT } from '../../../shared/src/ghost-markets/observe.js';
import { V33, signingAllowed, v41ReleaseRecord } from '../../../shared/src/ghost-markets/v33-release.js';
import { api } from '../api.js';
import { readNativeStatus, nativeSummary } from '../native-markets.js';
import { mountRuntime } from '../shell.js';
import { byId, initShell, setText } from '../ui.js';

initShell('protocol');
void mountRuntime();
for (const [id, value] of Object.entries({program:DEPLOYMENT.programId, data:DEPLOYMENT.programData, slot:'—', size:'—', hash:'—', authority:'—'})) setText(`native-${id}`, value);
byId<HTMLAnchorElement>('native-explorer').href = `https://explorer.solana.com/address/${DEPLOYMENT.programId}`;
byId<HTMLAnchorElement>('native-signature').href = `https://explorer.solana.com/tx/${DEPLOYMENT.signature}`;
const refresh = byId<HTMLButtonElement>('native-refresh');
async function read() {
  refresh.disabled = true;
  setText('native-status', 'Reading finalized public accounts…');
  setText('native-verified', 'Checking'); setText('native-config','Unknown'); setText('native-signing','Checking');
  const state = await readNativeStatus();
  setText('native-status', nativeSummary(state));
  if (state) {
    const o=state.observation, v33=o.release==='v33', v41=o.release==='v41';
    setText('native-verified', v41?'V41 matches release':v33?'V33 matches release':'V27 matches release');
    setText('native-config', o.config?.mode??(o.protocolInitialized?'Locked':'Not initialized'));
    setText('native-signing', signingAllowed(o,'buy')?'Owner-authorized · unaudited':signingAllowed(o,'sell')?'Exits / claims only':'Disabled');
    setText('native-slot', o.deploymentSlot);
    setText('native-size', `${(v41?(v41ReleaseRecord()?.binaryBytes??0):v33?V33.binaryBytes:DEPLOYMENT.binaryBytes).toLocaleString('en-US')} bytes`);
    setText('native-hash', o.binarySha256);
    setText('native-authority', DEPLOYMENT.upgradeAuthority);
  } else {
    setText('native-verified', 'Not verified'); setText('native-signing','Disabled');
    for (const id of ['slot','size','hash','authority']) setText(`native-${id}`, '—');
  }
  refresh.disabled = false;
}
async function registry() {
  try {
    const result = await api.ringCustom();
    if (!result.enabled || result.readAt === null || !Number.isFinite(result.readAt) || !Array.isArray(result.rings)) throw new Error('Registry unavailable');
    const activation = result.activation === 'open' ? 'Registration activation was permissionless' : result.activation === 'governance' ? 'Registration required governance activation' : 'Activation policy was unknown';
    setText('native-registry', `Last registry read: ${new Date(result.readAt).toISOString()}. ${result.rings.length} registered ring(s). ${activation} at the last recorded read. This is not a current GHOST authorization check.`);
  } catch { setText('native-registry', 'Public registry snapshot unavailable. No activation policy or ring status is inferred.'); }
}
refresh.addEventListener('click', () => { void read(); void registry(); });
void read(); void registry();
