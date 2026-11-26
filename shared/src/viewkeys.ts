/**
 * The keys behind a viewing pass (`viewpass.ts` says what one is).
 *
 * A wallet's Rings viewing key and nullifier key are derived from one
 * signature: the wallet's Ed25519 signature over the Rings derivation
 * message. A ghost wallet makes that signature from its seed; a wallet
 * extension is asked for it once when it connects. Whoever holds the
 * signature can rebuild both keys and so read the wallet. It is not a key
 * that signs anything: with it alone nothing can be moved.
 *
 * `viewerKeys` builds the reading keys WITHOUT a prover attached, so a page
 * that opens a pass can decrypt and can tell spent notes from unspent ones,
 * and cannot build a transaction of any kind.
 */

import { type Address, address as toAddress, getAddressEncoder } from '@solana/kit';
import { LocalShieldedKeys, ShieldedKeypair, SigningKey, initializePoseidon } from '@heliuslabs/spr';

export class ViewKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewKeysError';
  }
}

/** The address and the Rings derivation signature of the wallet a 32-byte seed makes. The caller wipes the signature when done. */
export function derivationSeedOf(seed: Uint8Array): { address: Address; signature: Uint8Array } {
  if (seed.length !== 32) throw new ViewKeysError('A wallet seed must be 32 bytes.');
  const key = SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never);
  try {
    const wallet = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never)).toSolanaSigner().address;
    return { address: wallet, signature: new Uint8Array(key.derivationSeed()) };
  } finally {
    key.destroy();
  }
}

/**
 * The reading keys of `owner`, from its derivation signature. The SDK checks
 * that the signature really is that wallet's before it derives anything, so a
 * pass relabelled for another wallet opens nothing.
 *
 * Deriving the keys hashes, so the SDK's hasher is loaded here first: a page
 * that opens a pass has not opened a wallet, and nothing else on it would
 * have loaded it.
 */
export async function viewerKeys(owner: string, signature: Uint8Array): Promise<LocalShieldedKeys> {
  if (signature.length !== 64) throw new ViewKeysError('A derivation signature is 64 bytes.');
  let wallet: Address;
  try {
    wallet = toAddress(owner);
    getAddressEncoder().encode(wallet);
  } catch {
    throw new ViewKeysError('That is not a wallet address.');
  }
  await initializePoseidon();
  try {
    return LocalShieldedKeys.fromDerivationSeed({ solanaPublicKey: wallet, derivationSeed: new Uint8Array(signature) });
  } catch (error) {
    // Only the SDK's own "this is not that wallet's signature" is told as such. Anything else is not the pass's fault.
    if ((error as { code?: unknown } | null)?.code === 'TRANSACTION_INVALID_DERIVATION_SEED') {
      throw new ViewKeysError('This viewing pass does not belong to the wallet it names, so nothing was opened.');
    }
    throw new ViewKeysError(`The reading keys could not be made in this browser (${error instanceof Error ? error.message.slice(0, 80) : 'unknown error'}). Nothing was opened. Try again.`);
  }
}
