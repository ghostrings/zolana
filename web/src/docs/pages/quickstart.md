Six steps. Each one is a single screen.

## 1. Open a wallet

Go to [Wallet](/wallet) and choose **Create**. Pick a passphrase of at least 8 characters and type it twice. A Solana keypair is made in your browser and encrypted with that passphrase.

The secret key is shown once, right after creation. Copy it somewhere safe before you do anything else: it is the only way to recover the wallet, and the passphrase cannot be reset.

Already use a Solana wallet extension? You can connect it instead. See [Your own wallet](/docs/external-wallets) for what works and what does not.

## 2. Fund it

Send SOL to the wallet's address from an exchange or another wallet. This is ordinary, public SOL.

> [!NOTE] Keep some SOL public
> Network fees and temporary account rent are always paid from the public balance. Keep at least {{gas_reserve}} SOL there. Most actions refuse to start with less.

## 3. Move SOL into your private balance

On the Wallet page, under **Move funds**, choose **Shield**, enter an amount and confirm. Shielding is a deposit into Rings, and the deposit itself is public: your wallet and the amount. From then on that SOL is an encrypted note that only your wallet can read.

You can skip this step for a first purchase. **Public entry** on a token page pays with public SOL and delivers the tokens straight into your private balance.

## 4. Buy a token

Open a token from the [Market](/). In the trading panel, beside the chart on a wide screen and under it on a phone:

:::steps
Choose a route | Shielded trades the Meteora pool directly. Ghost fill, when the desk is on, hides the token and the size. [Trading](/docs/trading) compares them.
Enter an amount | The quote shows exactly what you receive and the most you can pay.
Check "What an observer sees" | It lists what this particular trade reveals.
Press Buy and sign | The tokens arrive in your private balance in the same transaction.
:::

## 5. Hold, send, sell or burn

Your tokens now sit in your private balance. From here you can:

- **Hold them.** No explorer can show the amount.
- **Send them** to another registered wallet. See [Send privately](/docs/private-transfers).
- **Sell them** back to the pool from the same panel.
- **Burn them.** See [Burn tokens](/docs/burning).

## 6. Leave whenever you like

**Unshield** on the Wallet page moves SOL or tokens from your private balance to any Solana address, yours or someone else's. It is a withdrawal from Rings, and it is public: both wallets, the asset and the amount. After it, the funds are ordinary SOL or ordinary tokens that work in any wallet and on any exchange.

> [!WARNING] Before you put in more than a little
> This is new software on a new privacy system, and tokens launched here are experimental. Read [Risks](/docs/risks).
