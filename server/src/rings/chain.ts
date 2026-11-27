/**
 * The explorer's reads, against the real RPC and the real Rings indexer.
 *
 * Every call here is a read. The transaction itself is asked for as raw bytes
 * and decoded in this process, so a transaction version this code has not
 * seen fails in one place, loudly, instead of being half-understood.
 */

import { type Signature, address } from '@solana/kit';
import { type Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { getSolInterfaceAddress, getSplAssetVaultAddress, getUserRecordAddress } from '@heliuslabs/spr/addresses';
import type { SprClient } from '@heliuslabs/spr/client';
import { decodeSplAssetRegistry } from '@heliuslabs/spr/interface';

import { SPP_PROGRAM_ID, USER_REGISTRY_PROGRAM_ID } from '../../../shared/src/constants.js';
import { RING_CONFIG_SCAN } from '../../../shared/src/custom-rings.js';
import { createRingsClient, readProtocolFacts } from '../../../shared/src/privacy.js';
import { taggedEvents } from '../../../shared/src/ring-tags.js';
import { RINGS_REGISTRY_SCAN } from '../proxy.js';
import type { RawTransaction, RingEvent } from './decode.js';
import type { RingChain } from './indexer.js';

const REQUEST_TIMEOUT_MS = 20_000;
/** Past this many registered wallets the count is no longer asked for: the answer would be megabytes. */
const WALLET_COUNT_CEILING = 150_000;

export class RingRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RingRpcError';
  }
}

async function rpc(url: string, method: string, params: unknown, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new RingRpcError(`${method}: the RPC answered ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
  if (body.error) throw new RingRpcError(`${method}: ${typeof body.error.message === 'string' ? body.error.message.slice(0, 200) : 'the RPC returned an error'}`);
  return body.result;
}

function isRawTransaction(value: unknown): value is RawTransaction {
  const candidate = value as RawTransaction | null;
  return typeof candidate === 'object' && candidate !== null && Array.isArray(candidate.transaction) && typeof candidate.slot === 'number' && 'meta' in candidate;
}

export interface RingChainOptions {
  readonly rpcUrl: string;
  readonly sprUrl: string;
  readonly connection: Connection;
  readonly fetch?: typeof fetch;
}

export function createRingChain(options: RingChainOptions): RingChain & { isRegistered(owner: string): Promise<boolean> } {
  const { connection, rpcUrl, sprUrl } = options;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const program = new PublicKey(SPP_PROGRAM_ID);
  let client: Promise<SprClient> | undefined;
  /** The newest transaction version the RPC has been asked to return. Raised when it says a transaction needs more. */
  let maxVersion = 1;
  let walletsOff = false;

  const spr = (): Promise<SprClient> => {
    client ??= createRingsClient({ rpcUrl, sprUrl }).catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return client;
  };

  const getTransaction = async (signature: string): Promise<unknown> =>
    rpc(rpcUrl, 'getTransaction', [signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: maxVersion }], fetcher);

  return {
    solVault: String(getSolInterfaceAddress()),

    async signatures({ before, until, limit }) {
      const list = await connection.getSignaturesForAddress(program, { limit, ...(before ? { before } : {}), ...(until ? { until } : {}) }, 'confirmed');
      return list.map((entry) => ({ signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime ?? null, failed: entry.err !== null }));
    },

    async transaction(signature) {
      let result: unknown;
      try {
        result = await getTransaction(signature);
      } catch (error) {
        // "Transaction version (N) is not supported by the requesting client": ask again, allowing N.
        // The RPC words it as `"maxSupportedTransactionVersion": N`; older ones as `maxSupportedTransactionVersion set to N`.
        const wanted = error instanceof RingRpcError ? /maxSupportedTransactionVersion\D{0,16}(\d{1,3})/.exec(error.message) : null;
        const version = wanted ? Number(wanted[1]) : Number.NaN;
        if (!Number.isInteger(version) || version <= maxVersion || version > 255) throw error;
        maxVersion = version;
        result = await getTransaction(signature);
      }
      if (result === null || result === undefined) return null;
      if (!isRawTransaction(result)) throw new RingRpcError('getTransaction: the answer is not a transaction');
      return result;
    },

    async events(signature) {
      const response = await (await spr()).getShieldedTransactionsBySignature(signature as Signature);
      if (response.transactions.length === 0) return null;
      // The SDK's client hands each output tag on as 32 bytes; `taggedEvents` writes them as addresses.
      const events: RingEvent[] = taggedEvents(response);
      return events;
    },

    async registry() {
      const accounts = await connection.getProgramAccounts(program, {
        commitment: 'confirmed',
        filters: [{ dataSize: RINGS_REGISTRY_SCAN.dataSize }, { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.of(RINGS_REGISTRY_SCAN.type)) } }],
      });
      const entries: Array<{ mint: string; assetId: string }> = [];
      for (const { account } of accounts) {
        try {
          const decoded = decodeSplAssetRegistry(new Uint8Array(account.data));
          entries.push({ mint: String(decoded.mint), assetId: decoded.assetId.toString() });
        } catch {
          // Not a registration after all: an account of the same size with something else in it.
        }
      }
      return entries;
    },

    async ringConfigs() {
      const accounts = await connection.getProgramAccounts(program, {
        commitment: 'confirmed',
        filters: [{ dataSize: RING_CONFIG_SCAN.dataSize }, { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.of(RING_CONFIG_SCAN.type)) } }],
      });
      return accounts.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), data: new Uint8Array(account.data) }));
    },

    async ringActivationOpen() {
      return (await readProtocolFacts(await spr())).ringActivationIsPermissionless;
    },

    async accounts(addresses) {
      const out: Array<{ lamports: bigint; data: Uint8Array } | null> = [];
      for (let start = 0; start < addresses.length; start += 100) {
        const chunk = addresses.slice(start, start + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk.map((entry) => new PublicKey(entry)), 'confirmed');
        for (const info of infos) out.push(info ? { lamports: BigInt(info.lamports), data: new Uint8Array(info.data) } : null);
      }
      return out;
    },

    async walletCount() {
      if (walletsOff) return null;
      const accounts = await connection.getProgramAccounts(new PublicKey(USER_REGISTRY_PROGRAM_ID), { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } });
      if (accounts.length > WALLET_COUNT_CEILING) walletsOff = true;
      return accounts.length;
    },

    async names(mints) {
      const found = new Map<string, { symbol: string; name: string }>();
      for (let start = 0; start < mints.length; start += 100) {
        const result = await rpc(rpcUrl, 'getAssetBatch', { ids: mints.slice(start, start + 100) }, fetcher);
        if (!Array.isArray(result)) throw new RingRpcError('getAssetBatch: the answer is not a list');
        for (const entry of result as Array<{ id?: unknown; content?: { metadata?: { name?: unknown; symbol?: unknown } }; token_info?: { symbol?: unknown } } | null>) {
          if (!entry || typeof entry.id !== 'string') continue;
          const symbol = typeof entry.token_info?.symbol === 'string' ? entry.token_info.symbol : typeof entry.content?.metadata?.symbol === 'string' ? entry.content.metadata.symbol : '';
          const name = typeof entry.content?.metadata?.name === 'string' ? entry.content.metadata.name : '';
          found.set(entry.id, { symbol, name });
        }
      }
      return found;
    },

    async vaultOf(mint) {
      return String(await getSplAssetVaultAddress(address(mint)));
    },

    async rentFor(dataLength) {
      return BigInt(await connection.getMinimumBalanceForRentExemption(dataLength, 'confirmed'));
    },

    async isRegistered(owner) {
      const record = await getUserRecordAddress(address(owner));
      return (await connection.getAccountInfo(new PublicKey(String(record)), 'confirmed')) !== null;
    },
  };
}
