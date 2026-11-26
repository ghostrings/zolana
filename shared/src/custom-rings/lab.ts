/**
 * Deliberately synthetic in-memory policy model. NOT a wallet, protocol, ZK prover,
 * signature verifier, relayer or accounting system for real assets. No network,
 * external addresses, keys, persistence, real mints or real balances accepted.
 */
import { LAB_COSIGN_OPERATIONS } from './config.js';

export const LAB_ASSETS = ['TEST-SOL', 'TEST-TOKEN'] as const;
export type LabAsset = typeof LAB_ASSETS[number];
export const LAB_MEMBERS = Object.freeze(Array.from({ length: 12 }, (_, i) => `TEST-${String(i + 1).padStart(2, '0')}`));
export const LAB_OPERATIONS = LAB_COSIGN_OPERATIONS;
export type LabOperation = typeof LAB_OPERATIONS[number];
export const LAB_MAX_AMOUNT = 1_000_000n;
export interface LabLeg {
  readonly operation: LabOperation;
  readonly member: string;
  readonly recipient?: string;
  readonly asset: LabAsset;
  readonly amount: bigint;
}
export interface LabApproval {
  /** Simulation switches only: not cryptographic authorization. */
  readonly ownerApproved: boolean;
  readonly cosignerApproved: boolean;
}
export interface LabReceipt {
  readonly sequence: number;
  readonly operations: number;
  readonly result: 'accepted' | 'rejected';
  readonly reason: string;
}
export interface LabSnapshot {
  readonly source: 'synthetic-local';
  readonly asset: LabAsset;
  readonly sequence: number;
  readonly balances: readonly bigint[];
  readonly totalSupply: bigint;
}
export class LabPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'LabPolicyError'; }
}
const check = (value: unknown, message: string): void => { if (!value) throw new LabPolicyError(message); };
const isMember = (value: unknown): value is string => typeof value === 'string' && LAB_MEMBERS.includes(value);
const isAsset = (value: unknown): value is LabAsset => LAB_ASSETS.some((asset) => asset === value);
const key = (member: string, asset: LabAsset): string => `${member}:${asset}`;
const read = (ledger: ReadonlyMap<string, bigint>, member: string, asset: LabAsset): bigint => ledger.get(key(member, asset)) ?? 0n;

export class GhostRingLab {
  #ring = new Map<string, bigint>();
  #outside = new Map<string, bigint>();
  #blocked = new Set<string>();
  #frozen = new Set<string>();
  #paused = false;
  #sequence = 0;
  #receipts: LabReceipt[] = [];

  constructor() {
    for (const [i, member] of LAB_MEMBERS.entries()) {
      for (const asset of LAB_ASSETS) {
        this.#ring.set(key(member, asset), asset === 'TEST-SOL' ? 100n + BigInt(i) : 1000n + BigInt(i * 50));
        this.#outside.set(key(member, asset), asset === 'TEST-SOL' ? 500n : 5000n);
      }
    }
  }
  get paused(): boolean { return this.#paused; }
  setPaused(value: boolean): void { this.#paused = value === true; }
  setBlocked(member: string, value: boolean): void {
    check(isMember(member), 'Only a fictional lab participant is permitted.');
    if (value === true) this.#blocked.add(member); else this.#blocked.delete(member);
  }
  setFrozen(member: string, value: boolean): void {
    check(isMember(member), 'Only a fictional lab participant is permitted.');
    if (value === true) this.#frozen.add(member); else this.#frozen.delete(member);
  }
  isBlocked(member: string): boolean { return this.#blocked.has(member); }
  isFrozen(member: string): boolean { return this.#frozen.has(member); }
  balance(member: string, asset: LabAsset): { ring: bigint; outside: bigint } {
    check(isMember(member) && isAsset(asset), 'Only fictional lab participants and assets are permitted.');
    return { ring: read(this.#ring, member, asset), outside: read(this.#outside, member, asset) };
  }
  receipts(): readonly LabReceipt[] { return this.#receipts.map((entry) => ({ ...entry })); }
  snapshot(asset: LabAsset): LabSnapshot {
    check(isAsset(asset), 'Unknown fictional asset.');
    const balances = LAB_MEMBERS.map((member) => read(this.#ring, member, asset));
    const totalSupply = balances.reduce((sum, value) => sum + value, 0n)
      + LAB_MEMBERS.reduce((sum, member) => sum + read(this.#outside, member, asset), 0n);
    return { source: 'synthetic-local', asset, sequence: this.#sequence, balances, totalSupply };
  }
  /** Validate both legs before committing any state. On error both ledgers remain unchanged. */
  execute(legs: readonly LabLeg[], approval: LabApproval): LabReceipt {
    const sequence = ++this.#sequence;
    let receipt: LabReceipt;
    try {
      check(Array.isArray(legs) && legs.length >= 1 && legs.length <= 2, 'Use one operation or two atomic transfer legs.');
      check(!this.#paused, 'Ring is paused.');
      check(approval?.ownerApproved === true, 'Simulated owner approval is missing.');
      check(approval?.cosignerApproved === true, 'Simulated co-signer approval is missing.');
      for (const leg of legs) {
        check(!!leg && LAB_OPERATIONS.includes(leg.operation), 'Unknown operation.');
        check(isMember(leg.member) && isAsset(leg.asset), 'Only fictional lab participants and assets are permitted.');
        check(typeof leg.amount === 'bigint' && leg.amount > 0n && leg.amount <= LAB_MAX_AMOUNT, 'Amount must be a positive whole test unit within the lab limit.');
        check(leg.operation === 'transfer' ? isMember(leg.recipient) && leg.recipient !== leg.member : leg.recipient === undefined, 'Invalid fictional recipient.');
      }
      if (legs.length === 2) {
        const a = legs[0]!, b = legs[1]!;
        check(a.operation === 'transfer' && b.operation === 'transfer' && a.member === b.recipient && b.member === a.recipient && a.asset !== b.asset, 'Atomic fill requires two opposing transfer legs in different test assets.');
      }
      const ring = new Map(this.#ring), outside = new Map(this.#outside);
      for (const leg of legs) {
        const { member, operation, asset, amount } = leg;
        // Explicit LAB interpretation: block receiving inside ring; freeze spending from ring.
        // The upstream audited policy may differ, especially on deposit/withdrawal.
        const from = operation === 'deposit' ? outside : ring;
        const to = operation === 'withdraw' ? outside : ring;
        const recipient = operation === 'transfer' ? leg.recipient! : member;
        if (operation !== 'deposit') check(!this.#frozen.has(member), 'Sender is frozen.');
        if (operation !== 'withdraw') check(!this.#blocked.has(recipient), 'Recipient is blocklisted.');
        check(read(from, member, asset) >= amount, 'Insufficient test balance.');
        from.set(key(member, asset), read(from, member, asset) - amount);
        to.set(key(recipient, asset), read(to, recipient, asset) + amount);
      }
      this.#ring = ring;
      this.#outside = outside;
      receipt = { sequence, operations: legs.length, result: 'accepted', reason: 'Synthetic policy checks passed.' };
    } catch (error) {
      if (!(error instanceof LabPolicyError)) throw error;
      receipt = { sequence, operations: Array.isArray(legs) ? Math.min(legs.length, 2) : 0, result: 'rejected', reason: error.message };
    }
    this.#receipts.push(receipt);
    if (this.#receipts.length > 50) this.#receipts.shift();
    return { ...receipt };
  }
}
