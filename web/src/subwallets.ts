/**
 * The prvmax vaults of the wallet unlocked in this tab: their keys, their
 * sessions, and the little that is remembered about them in this browser.
 *
 * Keys are never stored. A wallet extension's vaults follow from one
 * signature, kept in sessionStorage for this tab only, the same way its Rings
 * viewing keys are. A ghost wallet's follow from its seed, which is already
 * in this tab while it is unlocked. Nothing here is sent to the server.
 *
 * One key, two sets (`VaultSetKind`). A ghost wallet holds the key itself, so
 * it can make the very signature an extension gives and open the same vaults:
 * the standard set. Earlier versions gave a ghost wallet vaults made from its
 * seed directly instead, which no extension can open: the ghost-only set. A
 * ghost wallet can open both, and `chooseVaultSet` says which one is shown.
 * An extension can open the standard set only.
 */

import bs58 from 'bs58';
import { type Address, getAddressEncoder } from '@solana/kit';

import {
  MAX_VAULTS,
  VaultError,
  type VaultSetChoice,
  type VaultSetKind,
  chooseVaultSet,
  otherVaultSet,
  rootFromSeed,
  rootFromSignature,
  vaultKeyMessage,
  vaultSeed,
} from '../../shared/src/vaults.js';
import { PRVMAX_PREFIX, SESSION_PRVMAX, storage } from './vault.js';
import { type Session, WalletError, ghostSeed, keypairFromSeed, sessionFromKeypair, signWithExternal, signWithSeed } from './wallet.js';

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export interface VaultHandle {
  /** 1 to 10. */
  readonly index: number;
  readonly address: Address;
  /** The vault as a wallet of its own. Built the first time it is asked for. */
  session(): Promise<Session>;
}

export interface VaultSet {
  readonly main: Session;
  /** All ten, whatever number the wallet chose to show. */
  readonly all: readonly VaultHandle[];
  /** Which of the wallet's two sets these are. An extension's are always the standard set. */
  readonly kind: VaultSetKind;
  /** Why this set is the one shown. */
  readonly reason: VaultSetChoice['reason'] | 'extension';
  /** False when the set was chosen without the chain's answer. Such a choice is not put on record. */
  readonly certain: boolean;
  /** The ten addresses of the wallet's other set, when this tab can make them: a ghost wallet's. Null for an extension. */
  readonly twin: readonly Address[] | null;
  /** Whether anything was ever found at the other set. Null when not known, or when there is no other set to look at. */
  readonly twinUsed: boolean | null;
  /**
   * The standard 64-byte Solana secret key of one of these vaults, base58.
   * Importing it into any wallet, or on this site's Wallet page, gives full
   * control of that vault without prvmax.
   */
  secret(index: number): Promise<string>;
}

export interface VaultPrefs {
  /** How many vaults the wallet uses, 1 to 10. */
  readonly count: number;
  /** The address vault 1 has in the set this browser shows. It marks the set; keys that give another address are not these vaults. */
  readonly check: string;
  /** Which set `check` belongs to. Records made before there were two sets do not say. */
  readonly set?: VaultSetKind;
  /** True when the person chose this set themselves. It is then never changed for them. */
  readonly pinned?: boolean;
}

export interface OpenOptions {
  /** Whether a wallet extension may be asked to sign. */
  readonly prompt: boolean;
  /** The set the person asks for. A ghost wallet only. */
  readonly set?: VaultSetKind;
  /**
   * Says whether anything ever happened at a set's addresses, or null when it
   * cannot tell. Asked once for each of a ghost wallet's sets, and for an
   * extension only when its vaults are not the ones on record.
   */
  readonly used?: (addresses: readonly Address[]) => Promise<boolean | null>;
}

export function readPrefs(owner: string): VaultPrefs | null {
  try {
    const raw = storage('local')?.getItem(PRVMAX_PREFIX + owner);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VaultPrefs>;
    if (typeof parsed.count !== 'number' || !Number.isInteger(parsed.count) || parsed.count < 1 || parsed.count > MAX_VAULTS) return null;
    if (typeof parsed.check !== 'string' || parsed.check.length < 32) return null;
    return {
      count: parsed.count,
      check: parsed.check,
      ...(parsed.set === 'seed' || parsed.set === 'signature' ? { set: parsed.set } : {}),
      ...(parsed.pinned === true ? { pinned: true } : {}),
    };
  } catch {
    return null;
  }
}

export function savePrefs(owner: string, prefs: VaultPrefs): void {
  if (!Number.isInteger(prefs.count) || prefs.count < 1 || prefs.count > MAX_VAULTS) throw new VaultError('BAD_COUNT', `Choose between 1 and ${MAX_VAULTS} vaults.`);
  const kept: VaultPrefs = { count: prefs.count, check: prefs.check, ...(prefs.set ? { set: prefs.set } : {}), ...(prefs.pinned === true ? { pinned: true } : {}) };
  storage('local')?.setItem(PRVMAX_PREFIX + owner, JSON.stringify(kept));
}

/**
 * What this browser has on record for an extension to be held to: the first
 * vault of the standard set. A record a ghost wallet left for its ghost-only
 * set says nothing about what an extension's signature should lead to.
 */
function extensionRecord(owner: string): VaultPrefs | null {
  const prefs = readPrefs(owner);
  return prefs && prefs.set !== 'seed' ? prefs : null;
}

/**
 * True when the vault keys can be derived right now without asking anyone:
 * always for a ghost wallet, and for a wallet extension once it has signed
 * the vault message in this tab.
 */
export function vaultsReady(main: Session): boolean {
  if (main.kind === 'ghost') return true;
  return cachedRoot(main.address) !== null;
}

function cachedRoot(owner: string): Uint8Array | null {
  try {
    const raw = storage('session')?.getItem(SESSION_PRVMAX);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { address?: unknown; root?: unknown };
    if (parsed.address !== owner || typeof parsed.root !== 'string') return null;
    const root = unb64(parsed.root);
    return root.length === 32 ? root : null;
  } catch {
    return null;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * The root of a wallet extension's vaults.
 *
 * This asks for a signature, and asks twice the first time: vault keys can
 * only be found again if the wallet signs the same message the same way every
 * time. One that does not would lock its owner out of the vaults the moment
 * this tab closes, so it is refused here, before anything is ever sent to a
 * vault. Once this browser has the first vault's address on record, one
 * signature is enough: `openVaults` compares what it leads to with that
 * record.
 */
async function extensionRoot(main: Session, prompt: boolean): Promise<Uint8Array | null> {
  const cached = cachedRoot(main.address);
  if (cached) return cached;
  if (!prompt) return null;
  const message = vaultKeyMessage(main.address);
  const first = await signWithExternal(message);
  if (extensionRecord(main.address) === null) {
    const second = await signWithExternal(message);
    if (!sameBytes(first, second)) {
      throw new WalletError(
        'This wallet signed the same message two different ways, so the keys of its vaults could not be found again later. prvmax cannot be used with it. Use the ghost wallet instead.',
      );
    }
  }
  const root = await rootFromSignature(first);
  storage('session')?.setItem(SESSION_PRVMAX, JSON.stringify({ address: main.address, root: b64(root) }));
  return root;
}

/**
 * Both roots of a ghost wallet: the one made from its seed directly, and the
 * one made from its own signature over the vault message, which is the root
 * an extension holding the same key arrives at.
 */
async function ghostRoots(owner: string): Promise<Record<VaultSetKind, Uint8Array>> {
  const seed = ghostSeed();
  if (!seed) throw new WalletError('Unlock the ghost wallet first.');
  let signature: Uint8Array | null = null;
  try {
    // The message names the wallet, so the seed in this tab has to be that wallet's.
    if (keypairFromSeed(seed).toSolanaSigner().address !== owner) throw new WalletError('The wallet in this tab changed. Reload the page.');
    signature = signWithSeed(seed, vaultKeyMessage(owner));
    return { seed: await rootFromSeed(seed), signature: await rootFromSignature(signature) };
  } finally {
    seed.fill(0);
    signature?.fill(0);
  }
}

async function addressesUnder(root: Uint8Array): Promise<Address[]> {
  const addresses: Address[] = [];
  for (let index = 1; index <= MAX_VAULTS; index += 1) {
    const seed = await vaultSeed(root, index);
    addresses.push(keypairFromSeed(seed).toSolanaSigner().address);
    seed.fill(0);
  }
  return addresses;
}

type Described = Pick<VaultSet, 'kind' | 'reason' | 'certain' | 'twin' | 'twinUsed'>;

function build(main: Session, root: Uint8Array, addresses: readonly Address[], described: Described): VaultSet {
  const sessions = new Map<number, Promise<Session>>();
  const all: VaultHandle[] = addresses.map((address, position) => {
    const index = position + 1;
    return {
      index,
      address,
      session() {
        let session = sessions.get(index);
        if (!session) {
          session = (async () => {
            const again = await vaultSeed(root, index);
            try {
              return await sessionFromKeypair(keypairFromSeed(again), `Vault ${index}`);
            } finally {
              again.fill(0);
            }
          })();
          sessions.set(index, session);
          session.catch(() => sessions.delete(index));
        }
        return session;
      },
    };
  });
  return {
    main,
    all,
    ...described,
    async secret(index: number): Promise<string> {
      const seed = await vaultSeed(root, index);
      const publicKey = getAddressEncoder().encode(keypairFromSeed(seed).toSolanaSigner().address);
      const secret = new Uint8Array(64);
      secret.set(seed, 0);
      secret.set(publicKey, 32);
      const text = bs58.encode(secret);
      seed.fill(0);
      secret.fill(0);
      return text;
    },
  };
}

/**
 * Opens the vaults of `main`. Null when the keys are not in this tab yet and
 * `prompt` is false.
 *
 * For a wallet extension it throws when the keys derived now are not the
 * ones this browser saw when the vaults were made, unless the chain shows
 * that the vaults they lead to are already in use. For a ghost wallet there
 * is nothing to refuse: both of its sets can always be made again, and the
 * one shown is the one `chooseVaultSet` picks.
 */
export async function openVaults(main: Session, options: OpenOptions): Promise<VaultSet | null> {
  const prefs = readPrefs(main.address);
  if (main.kind !== 'ghost') {
    const root = await extensionRoot(main, options.prompt);
    if (!root) return null;
    const addresses = await addressesUnder(root);
    const held = extensionRecord(main.address);
    // A record of other vaults. When something has already happened at the vaults this signature leads
    // to, they exist and were reached with this same signature before, so the record is what is out of
    // date: a ghost wallet with this address left it, for its ghost-only set, before records said which
    // set they were of. Otherwise the wallet may be signing differently than it did, and nothing is opened.
    const reached = held && held.check !== addresses[0] && options.used ? await options.used(addresses).catch(() => null) : null;
    if (held && held.check !== addresses[0] && reached !== true) {
      storage('session')?.removeItem(SESSION_PRVMAX);
      throw new WalletError(
        'The keys derived now are not the keys of the vaults this browser set up for this wallet: the wallet gave a different signature than before. Nothing was opened. Connect the same wallet, the same way, as when the vaults were set up. If these vaults were made by a ghost wallet with this address, open them from the ghost wallet.',
      );
    }
    return build(main, root, addresses, { kind: 'signature', reason: 'extension', certain: true, twin: null, twinUsed: null });
  }

  const roots = await ghostRoots(main.address);
  const addresses = { seed: await addressesUnder(roots.seed), signature: await addressesUnder(roots.signature) };
  let used: Record<VaultSetKind, boolean | null> | null = null;
  if (options.used) {
    const ask = async (set: VaultSetKind): Promise<boolean | null> => {
      try {
        return await (options.used as NonNullable<OpenOptions['used']>)(addresses[set]);
      } catch {
        return null;
      }
    };
    const [seed, signature] = await Promise.all([ask('seed'), ask('signature')]);
    used = { seed, signature };
  }
  const choice = chooseVaultSet({
    first: { seed: addresses.seed[0] as Address, signature: addresses.signature[0] as Address },
    recorded: prefs ? { check: prefs.check, pinned: prefs.pinned === true } : null,
    used,
    asked: options.set ?? null,
  });
  const other = otherVaultSet(choice.set);
  roots[other].fill(0);
  return build(main, roots[choice.set], addresses[choice.set], { kind: choice.set, reason: choice.reason, certain: choice.certain, twin: addresses[other], twinUsed: choice.otherUsed });
}
