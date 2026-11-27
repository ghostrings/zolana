/**
 * The desk's blocklist and the export of its fills.
 */

import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';

import { fillCount, fillRows, isInside } from '../shared/src/desk-fills.js';
import type { HistoryRow } from '../shared/src/privacy.js';
import { buildStatement, statementCsv } from '../shared/src/statement.js';
import { Desk, DeskError } from '../server/src/desk.js';
import { EnvError, readEnv } from '../server/src/env.js';

const fresh = (): string => Keypair.generate().publicKey.toBase58();
const SOL = 'So11111111111111111111111111111111111111112';

describe('wallets the desk does not trade with', () => {
  it('are read from DESK_BLOCKED_WALLETS, however they are separated', () => {
    const [a, b, c] = [fresh(), fresh(), fresh()];
    expect(readEnv({}).desk.blockedWallets.size).toBe(0);
    const env = readEnv({ DESK_BLOCKED_WALLETS: `${a}, ${b}\n${c} ${a}` });
    expect([...env.desk.blockedWallets].sort()).toEqual([a, b, c].sort());
  });

  it('stop the server from starting when one of them is not an address', () => {
    expect(() => readEnv({ DESK_BLOCKED_WALLETS: `${fresh()}, not-an-address` })).toThrow(EnvError);
    // A character base58 does not have, and an address cut far too short.
    expect(() => readEnv({ DESK_BLOCKED_WALLETS: `0${fresh().slice(1)}` })).toThrow('DESK_BLOCKED_WALLETS must be a comma-separated list of Solana addresses.');
    expect(() => readEnv({ DESK_BLOCKED_WALLETS: fresh().slice(0, 20) })).toThrow(EnvError);
  });

  it('are refused before the desk does any work, and nobody else is', async () => {
    const blocked = fresh();
    const logs: string[] = [];
    const desk = new Desk(readEnv({ DESK_BLOCKED_WALLETS: blocked }), {} as never, {} as never, (message) => logs.push(message));
    const ask = (trader: string): Promise<unknown> => desk.prepare({ quoteId: 'q1', trader, leg: {} } as never);

    const refusal = await ask(blocked).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeskError);
    expect(refusal).toMatchObject({ code: 'NOT_SERVED', status: 403 });
    expect((refusal as DeskError).message).toBe('The desk does not trade with this wallet. The Shielded route is not affected by that.');
    expect(logs).toEqual([`desk: refused a fill for ${blocked}, which is on DESK_BLOCKED_WALLETS`]);

    // Asked again within the hour, it is refused again and the log is not filled with it.
    await ask(blocked).catch(() => undefined);
    expect(logs).toHaveLength(1);

    // Any other wallet gets whatever the desk would say anyway: here, that this desk was never started.
    const other = await ask(fresh()).catch((error: unknown) => error);
    expect(other).toMatchObject({ code: 'DESK_OFF' });
    expect(logs).toHaveLength(1);
  });
});

describe('the desk’s fills, out of its own statement', () => {
  const DESK = fresh();
  const TRADER = fresh();
  const TOKEN = fresh();
  const row = (signature: string, slot: bigint, kind: string, direction: HistoryRow['direction'], asset: string, amount: bigint, index = 0): HistoryRow =>
    ({ signature, slot, index, kind, direction, asset, amount }) as unknown as HistoryRow;
  const history: HistoryRow[] = [
    // A fill: the trader pays 0.02 SOL in, the desk pays 310 tokens out, in one transaction.
    row('fill1', 10n, 'privateTransfer', 'inbound', SOL, 20_000_000n, 0),
    row('fill1', 10n, 'privateTransfer', 'outbound', TOKEN, 310_000_000n, 1),
    // A plain private payment to the desk: not a fill.
    row('gift', 11n, 'privateTransfer', 'inbound', SOL, 5_000_000n),
    // The desk restocking on the pool: a trade, and not a fill with anybody.
    row('restock', 12n, 'publicWithdrawal', 'outbound', SOL, 50_000_000n, 0),
    row('restock', 12n, 'deposit', 'inbound', TOKEN, 700_000_000n, 1),
    // The desk consolidating its own notes.
    row('merge', 13n, 'merge', 'selfTransfer', SOL, 70_000_000n),
    // A second fill, the other way round.
    row('fill2', 14n, 'privateTransfer', 'inbound', TOKEN, 100_000_000n, 0),
    row('fill2', 14n, 'privateTransfer', 'outbound', SOL, 6_000_000n, 1),
  ];
  const statement = buildStatement(
    history,
    {
      time: (slot) => 1_800_000_000 + Number(slot),
      label: (mint) => (mint === SOL ? { symbol: 'SOL', decimals: 9, native: true } : { symbol: 'TOK', decimals: 6 }),
      others: (signature) => (signature.startsWith('fill') || signature === 'gift' ? [TRADER] : []),
      memo: () => undefined,
    },
    { from: null, to: null, label: 'All time' },
  );

  it('are the private transfers that came with another token going the other way', () => {
    const fills = fillRows(statement.rows);
    expect(fills.map((entry) => [entry.signature, entry.direction, entry.symbol, entry.amount, entry.tradedFor, entry.counterparty])).toEqual([
      ['fill1', 'In', 'SOL', '0.02', 'TOK', TRADER],
      ['fill1', 'Out', 'TOK', '310', 'SOL', TRADER],
      ['fill2', 'In', 'TOK', '100', 'SOL', TRADER],
      ['fill2', 'Out', 'SOL', '0.006', 'TOK', TRADER],
    ]);
    expect(fillCount(statement.rows)).toBe(2);
    expect(statement.rows).toHaveLength(history.length); // the whole statement still has every row
    void DESK;
  });

  it('are written as the same file a wallet’s statement is', () => {
    const lines = statementCsv(fillRows(statement.rows)).trimEnd().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('Counterparty');
    expect(lines[1]).toContain(',Private transfer,In,SOL,0.02,');
    expect(lines[1]).toContain(TRADER);
  });

  it('are never written into the project folder', () => {
    expect(isInside('/home/me/project/fills.csv', '/home/me/project', '/')).toBe(true);
    expect(isInside('/home/me/project/sub/fills.csv', '/home/me/project/', '/')).toBe(true);
    expect(isInside('/home/me/project', '/home/me/project', '/')).toBe(true);
    expect(isInside('/home/me/fills.csv', '/home/me/project', '/')).toBe(false);
    expect(isInside('/home/me/project-old/fills.csv', '/home/me/project', '/')).toBe(false);
    // Windows: the same folder whatever the case of its letters.
    expect(isInside('C:\\Users\\Me\\Desktop\\PrivacyCashFun\\fills.csv', 'c:\\users\\me\\desktop\\privacycashfun', '\\')).toBe(true);
    expect(isInside('C:\\Users\\Me\\fills.csv', 'C:\\Users\\Me\\Desktop\\privacycashfun', '\\')).toBe(false);
  });
});
