/**
 * What the Rings explorer's routes answer.
 *
 * Everything here is read from public chain data: the transactions of the
 * Solana Privacy Program, the balances of its vaults, and its token registry.
 * Nothing is decrypted and no key is involved, so a private balance, or the
 * token and amount of a private transfer, cannot appear in any of it.
 */

/** What a transaction of the Rings program did, as far as an outsider can tell. */
export type RingKind =
  /** Public to private. Wallet, token and amount are public. */
  | 'shield'
  /** Private to public. Wallet, token and amount are public. */
  | 'unshield'
  /** Out of a private balance, through a pool, and back in, in one transaction. Both sides are public. */
  | 'trade'
  /** Private to private, between wallets. Only the wallets are public. */
  | 'transfer'
  /** Two wallets paying each other privately in one transaction. Only the wallets are public. */
  | 'swap'
  /** A wallet moving its own private balance: consolidating it, or a transfer to itself. */
  | 'self'
  /** A private move whose receiving side has not been read from the indexer yet. */
  | 'private'
  /** A token was registered with Rings, so it can be held privately from now on. */
  | 'token'
  /** The protocol's own housekeeping. */
  | 'upkeep'
  | 'other';

export const RING_KINDS: readonly RingKind[] = ['shield', 'unshield', 'trade', 'transfer', 'swap', 'self', 'private', 'token', 'upkeep', 'other'];

/** One public movement into or out of Rings. `in` is into a private balance. */
export interface RingLeg {
  readonly mint: string;
  /** Base units. */
  readonly amount: string;
  readonly dir: 'in' | 'out';
}

export interface RingRow {
  readonly signature: string;
  readonly slot: number;
  /** Block time, in milliseconds since 1970. */
  readonly at: number;
  readonly kind: RingKind;
  /** Who paid the transaction fee. */
  readonly payer: string;
  /** Wallets whose funds the transaction moved. */
  readonly senders: readonly string[];
  /** Wallets that were paid, when they are not the senders themselves. */
  readonly recipients: readonly string[];
  /** The public movements: empty for anything that stayed private. */
  readonly legs: readonly RingLeg[];
  /** Other programs the transaction called, by name where it is a known one. */
  readonly via: readonly string[];
  /** The program of the ring that authorised it, when it was not the Default Ring. */
  readonly ring: string | null;
}

export interface RingAsset {
  readonly mint: string;
  /** Empty when no name could be read for the token. */
  readonly symbol: string;
  readonly name: string;
  readonly image: string;
  readonly decimals: number;
  /** Base units in existence. Empty when it could not be read. */
  readonly supply: string;
  /** Base units held in the token's Rings vault: everything of it that anyone holds privately. */
  readonly shielded: string;
  /** `shielded` over `supply`, in hundredths of a percent. Null when the supply is unknown or zero. */
  readonly shareBps: number | null;
  /** Net movement into Rings over the window, in base units. Negative when more left than came. */
  readonly flow24h: string;
  readonly flow7d: string;
  /** Shields and unshields in the last day. */
  readonly moves24h: number;
  /** Launched on this site, so it has a page here. */
  readonly listed: boolean;
  /** The shielded amount over the last seven days, oldest first, each as a share of the largest (0 to 1). */
  readonly trail: readonly number[];
  /** When this server first saw the token registered. */
  readonly firstSeen: number;
}

export type RingAssetSort = 'shielded' | 'share' | 'flow24h' | 'flow7d' | 'active' | 'new';
export const RING_ASSET_SORTS: readonly RingAssetSort[] = ['shielded', 'share', 'flow24h', 'flow7d', 'active', 'new'];

export const RING_PAGE_SIZE = 25;

export interface RingAssetPage {
  readonly assets: readonly RingAsset[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
  readonly size: number;
}

export interface RingOverview {
  /** False when this server does not follow Rings: nothing below means anything then. */
  readonly enabled: boolean;
  /** The oldest and newest transactions read so far. Null before the first read. */
  readonly since: number | null;
  readonly through: number | null;
  /** True once history has been read back to where it was told to stop. */
  readonly complete: boolean;
  /** Tokens registered with Rings. */
  readonly tokens: number;
  /** Wallets registered to receive privately. Null when it has not been counted. */
  readonly wallets: number | null;
  readonly tx24h: number;
  readonly txAll: number;
  /** Wallets that sent or were paid in the last day. */
  readonly active24h: number;
  readonly shields24h: number;
  readonly unshields24h: number;
  readonly transfers24h: number;
  /** SOL held privately by everyone together, and its net movement over a day, in lamports. */
  readonly solShielded: string;
  readonly solFlow24h: string;
}

/** What a page needs to write an amount of a token: its ticker and decimals, by mint. Tokens Rings does not know are absent. */
export type RingLabels = Readonly<Record<string, { readonly symbol: string; readonly decimals: number; readonly listed: boolean }>>;

export interface RingFeed {
  readonly rows: readonly RingRow[];
  readonly labels: RingLabels;
  /** Pass as `before` for the next, older, page. Null at the end. */
  readonly next: string | null;
}

export interface RingCounterparty {
  readonly address: string;
  /** Private transfers this wallet sent to it, and received from it. */
  readonly sent: number;
  readonly received: number;
  readonly last: number;
}

export interface RingAddressView {
  readonly address: string;
  /** Whether the wallet has a public Rings registration. Null when that could not be read. */
  readonly registered: boolean | null;
  readonly first: number | null;
  readonly last: number | null;
  readonly counts: {
    readonly shields: number;
    readonly unshields: number;
    readonly trades: number;
    readonly sent: number;
    readonly received: number;
    readonly own: number;
  };
  readonly counterparties: readonly RingCounterparty[];
  readonly rows: readonly RingRow[];
  readonly labels: RingLabels;
  readonly next: string | null;
  /** The oldest transaction this server has read. Activity before it is not shown. */
  readonly since: number | null;
  readonly complete: boolean;
}

/** One token as the explorer shows it on its own, with its latest public movements. */
export interface RingAssetView {
  readonly asset: RingAsset;
  readonly rows: readonly RingRow[];
  readonly labels: RingLabels;
  /** Wallets that have shielded this token, and that have unshielded it, in the history read so far. */
  readonly shielders: number;
  readonly unshielders: number;
}
