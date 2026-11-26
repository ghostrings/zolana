import { createPrivateKey, randomBytes, sign as signEd25519 } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAddressEncoder } from '@solana/kit';
import { LocalShieldedKeys, ShieldedKeypair, SigningKey } from '@heliuslabs/spr';
import { ed25519DerivationMessage, isPoseidonInitialized } from '@heliuslabs/spr/keypair';

import { vaultKeyMessage } from '../shared/src/vaults.js';
import { ViewKeysError, derivationSeedOf, viewerKeys } from '../shared/src/viewkeys.js';
import { PASS_MIN_PASSPHRASE, PASS_PREFIX, PassError, openPass, passAddress, sealPass } from '../shared/src/viewpass.js';

/** Enough work for a test to be honest about the construction, and no slower than it has to be. */
const FAST = 100_000;
const PASSPHRASE = 'correct horse battery';

const seedBytes = (): Uint8Array => new Uint8Array(randomBytes(32));
const keypairOf = (seed: Uint8Array): ShieldedKeypair => ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** An Ed25519 signature made by Node itself, with no code of the Rings SDK in it. */
function plainSignature(seed: Uint8Array, message: Uint8Array): Uint8Array {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  return new Uint8Array(signEd25519(null, message, key));
}

describe('the keys a viewing pass carries', () => {
  // First in this file on purpose: nothing has loaded the SDK's hasher yet, as on a page that only opens a pass.
  it('are made on a page that has opened no wallet before', async () => {
    expect(isPoseidonInitialized()).toBe(false);
    const { address, signature } = derivationSeedOf(seedBytes());
    const viewer = await viewerKeys(address, signature);
    expect(viewer.address().solanaAddress()).toBe(address);
    expect(isPoseidonInitialized()).toBe(true);
  });

  it('come from the signature a wallet extension gives for the Rings derivation message', () => {
    const seed = seedBytes();
    const { address, signature } = derivationSeedOf(seed);
    const message = ed25519DerivationMessage(new Uint8Array(getAddressEncoder().encode(address)) as never);
    expect(address).toBe(keypairOf(seed).toSolanaSigner().address);
    expect(signature).toHaveLength(64);
    // Exactly the bytes any Ed25519 signer gives for that message with this key: what an extension returns when it connects.
    expect(hex(signature)).toBe(hex(plainSignature(seed, message)));
    // The same seed gives the same signature every time: Ed25519 signing has no randomness in it.
    expect(hex(derivationSeedOf(seed).signature)).toBe(hex(signature));
  });

  it('open exactly the wallet the secret key opens: the same viewing key and the same nullifier key', async () => {
    for (let round = 0; round < 3; round += 1) {
      const seed = seedBytes();
      const keypair = keypairOf(seed);
      const own = LocalShieldedKeys.fromKeypair(keypair);
      const { address, signature } = derivationSeedOf(seed);
      const viewer = await viewerKeys(address, signature);
      // The shielded address is the signing key, the nullifier public key and the viewing public key, in that order.
      expect(hex(viewer.address().toBytes())).toBe(hex(keypair.shieldedAddress().toBytes()));
      expect(viewer.viewingPublicKeys().map((key) => hex(key.toBytes()))).toEqual(own.viewingPublicKeys().map((key) => hex(key.toBytes())));
      // The nullifier of the same note comes out the same, so a viewer tells spent from unspent exactly as the wallet does.
      const utxoHash = new Uint8Array(32).fill(7) as never;
      const blinding = new Uint8Array(32).fill(9) as never;
      expect(hex(viewer.deriveOne({ kind: 'nullifier', utxoHash, blinding }))).toBe(hex(own.deriveOne({ kind: 'nullifier', utxoHash, blinding })));
    }
  });

  it('are refused for a wallet they do not belong to, and the refusal says that', async () => {
    const mine = derivationSeedOf(seedBytes());
    const theirs = derivationSeedOf(seedBytes());
    await expect(viewerKeys(theirs.address, mine.signature)).rejects.toThrow(/does not belong to the wallet it names/);
    await expect(viewerKeys(mine.address, new Uint8Array(64))).rejects.toThrow(/does not belong to the wallet it names/);
    await expect(viewerKeys(mine.address, mine.signature.slice(0, 63))).rejects.toThrow(ViewKeysError);
    await expect(viewerKeys('not an address', mine.signature)).rejects.toThrow(/not a wallet address/);
  });

  it('are not the signature a prvmax vault is made from', () => {
    const seed = seedBytes();
    const { address, signature } = derivationSeedOf(seed);
    expect(hex(signature)).not.toBe(hex(plainSignature(seed, vaultKeyMessage(address))));
  });

  it('cannot be had from the SDK by asking it to sign the derivation message as if it were any other', () => {
    const seed = seedBytes();
    const key = SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never);
    const message = ed25519DerivationMessage(new Uint8Array(getAddressEncoder().encode(derivationSeedOf(seed).address)) as never);
    expect(() => key.sign(message)).toThrow(/KEYPAIR_DERIVATION_INPUT/);
  });

  it('refuse a seed of the wrong size', () => {
    expect(() => derivationSeedOf(new Uint8Array(31))).toThrow(ViewKeysError);
  });
});

describe('a viewing pass', () => {
  it('opens with its passphrase to the wallet and signature it was made from', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const pass = await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 1_764_000_000_000, name: 'Savings', iterations: FAST });
    expect(pass.startsWith(PASS_PREFIX)).toBe(true);
    expect(passAddress(pass)).toBe(address);
    const opened = await openPass(pass, PASSPHRASE);
    expect(opened.address).toBe(address);
    expect(hex(opened.seed)).toBe(hex(signature));
    expect(opened.created).toBe(1_764_000_000_000);
    expect(opened.name).toBe('Savings');
    // And what comes out of it reads the wallet.
    expect((await viewerKeys(opened.address, opened.seed)).address().solanaAddress()).toBe(address);
  });

  it('does not contain the signature, or anything of it, in the clear', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const pass = await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 1, iterations: FAST });
    const inside = Buffer.from(pass.slice(PASS_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
    expect(Object.keys(JSON.parse(inside) as object).sort()).toEqual(['address', 'ciphertext', 'created', 'iterations', 'iv', 'name', 'salt', 'v']);
    expect(inside).not.toContain(Buffer.from(signature).toString('base64').slice(0, 16));
    expect(inside).not.toContain(hex(signature).slice(0, 16));
  });

  it('is different every time it is made, and each one opens', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const input = { address, seed: signature, passphrase: PASSPHRASE, created: 5, iterations: FAST };
    const [first, second] = [await sealPass(input), await sealPass(input)];
    expect(first).not.toBe(second);
    expect(hex((await openPass(second, PASSPHRASE)).seed)).toBe(hex(signature));
  });

  it('leaves the signature it was given as it was', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const before = hex(signature);
    await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 5, iterations: FAST });
    expect(hex(signature)).toBe(before);
  });

  it('stays shut for a wrong passphrase', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const pass = await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 5, iterations: FAST });
    await expect(openPass(pass, `${PASSPHRASE}!`)).rejects.toMatchObject({ name: 'PassError', code: 'PASSPHRASE' });
    await expect(openPass(pass, '')).rejects.toMatchObject({ code: 'PASSPHRASE' });
  });

  it('cannot be relabelled for another wallet, another date or less work', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const other = derivationSeedOf(seedBytes()).address;
    const pass = await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 5, iterations: FAST });
    const body = JSON.parse(Buffer.from(pass.slice(PASS_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    const forge = (change: Record<string, unknown>): string => `${PASS_PREFIX}${Buffer.from(JSON.stringify({ ...body, ...change })).toString('base64url')}`;
    await expect(openPass(forge({ address: other }), PASSPHRASE)).rejects.toMatchObject({ code: 'PASSPHRASE' });
    await expect(openPass(forge({ created: 6 }), PASSPHRASE)).rejects.toMatchObject({ code: 'PASSPHRASE' });
    await expect(openPass(forge({ iterations: FAST + 1 }), PASSPHRASE)).rejects.toMatchObject({ code: 'PASSPHRASE' });
    // The name is a label and nothing more: changing it opens the same wallet.
    expect((await openPass(forge({ name: 'Renamed' }), PASSPHRASE)).name).toBe('Renamed');
  });

  it('refuses a pass that asks for too little work, or for more than anyone would wait for', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const pass = await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 5, iterations: FAST });
    const body = JSON.parse(Buffer.from(pass.slice(PASS_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const iterations of [1, 99_999, 2_000_001, 1.5, '310000']) {
      const forged = `${PASS_PREFIX}${Buffer.from(JSON.stringify({ ...body, iterations })).toString('base64url')}`;
      await expect(openPass(forged, PASSPHRASE)).rejects.toMatchObject({ code: 'FORMAT' });
    }
  });

  it('opens when it was pasted with line breaks and spaces in it', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const pass = await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 5, iterations: FAST });
    const wrapped = `  ${pass.match(/.{1,40}/g)?.join('\r\n') ?? pass}\n`;
    expect((await openPass(wrapped, PASSPHRASE)).address).toBe(address);
  });

  it('says so when the text is not a pass, or is a damaged one', async () => {
    for (const text of ['', 'hello', 'pcfview1.', 'pcfview1.!!!', `pcfview1.${Buffer.from('{"v":2}').toString('base64url')}`, `pcfview1.${Buffer.from('[1,2]').toString('base64url')}`, 'pcfview2.abc']) {
      await expect(openPass(text, PASSPHRASE), text).rejects.toBeInstanceOf(PassError);
      expect(() => passAddress(text), text).toThrow(PassError);
    }
  });

  it('is not made with a short passphrase, or from something that is not a signature', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    await expect(sealPass({ address, seed: signature, passphrase: 'x'.repeat(PASS_MIN_PASSPHRASE - 1), created: 5, iterations: FAST })).rejects.toMatchObject({ code: 'WEAK' });
    await expect(sealPass({ address, seed: signature.slice(0, 32), passphrase: PASSPHRASE, created: 5, iterations: FAST })).rejects.toMatchObject({ code: 'FORMAT' });
  });

  it('keeps a name to one short line of visible characters', async () => {
    const { address, signature } = derivationSeedOf(seedBytes());
    const name = `Main${String.fromCodePoint(0x202e)}\n wallet with a very long name indeed`;
    const pass = await sealPass({ address, seed: signature, passphrase: PASSPHRASE, created: 5, name, iterations: FAST });
    const opened = await openPass(pass, PASSPHRASE);
    expect(opened.name).toBe('Main wallet with a very');
    expect([...opened.name].length).toBeLessThanOrEqual(24);
  });
});
