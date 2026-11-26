A private transfer moves a token, or SOL, from your private balance into someone else's. The chain records that one wallet sent the other something. It does not record which token, or how much.

:::observer A private transfer
Your wallet and the recipient's | public
That one sent the other something | public
Which token | hidden
How much | hidden
:::

## Before you send

Three things have to be true.

1. **You hold it privately.** A token you bought here is already in your private balance. A token in your public balance has to be shielded first.
2. **The recipient is registered.** Their wallet must have registered with Rings, which publishes the encryption key your transfer is locked to. The form checks this as you type the address.
3. **You have public SOL for the fee.** At least {{gas_reserve}} SOL.

## Sending from a token's page

:::steps
Open the token | From the Market, or from a holding on your Wallet page.
Find "Send or burn" and pick Send privately | The panel shows your private and public balance of that token.
Paste the recipient's Solana address | Their ordinary address. The line under the field says whether it can receive privately.
Enter the amount | Or use 25%, 50% or MAX.
Press Send privately and sign | The page builds a proof, which takes a few seconds, then asks your wallet to sign.
:::

## Sending from the Wallet page

Under **Move funds**, choose **Send** and leave **Send from** on the private balance. Pick the asset and fill in the same two fields. Every private holding also has a **Send** button that opens the form with that asset chosen. This is the place to send SOL privately, or a token you hold that was not launched here.

If somebody sent you a [payment request](/docs/payment-requests), opening their link fills this form in for you to check.

Your other wallets and your contacts are offered as buttons under the address field. An address this browser has a name for is shown by that name, which makes a slip in a pasted address easier to see.

The same form can send from the public balance instead. That is an ordinary Solana transfer and hides nothing. See [Several wallets](/docs/wallets#sending-between-wallets).

## What the recipient sees

The amount appears in their private balance the next time their wallet reads the chain: when they open or reload their Wallet page, or the token's page. Their private history lists it as a private transfer, in.

Nothing on chain notifies them. If they have [alerts](/docs/alerts) on and this site open, their browser tells them within a minute or two; otherwise tell them to reload.

## If the recipient is not registered

The transfer is refused before anything is built or signed, so nothing moves. You have two options:

- Ask them to register. They open the [Wallet](/wallet) page here with the wallet that owns the address and press **Register**. It is a one-time, public step, paid from their public SOL.
- Unshield to them instead. It pays any Solana address, but it is public. See [Shield and unshield](/docs/deposit-withdraw).

## What it costs

- No fee to this site.
- The Solana network fee, paid from your public SOL.
- Any protocol fee Solana Privacy Rings charges on the transaction.

The recipient pays nothing to receive.

## Good to know

- **It is final.** Once it lands, only the recipient can send it back. Check the address.
- **Any wallet can send.** The ghost wallet and wallet extensions both work.
- **Too many notes.** If your holding is split across many small notes, sending can fail with a message saying so. Consolidate the holding on the Wallet page and try again.
- **The exact amount arrives.** No fee is taken out of what you send.
- **An exchange cannot receive this way.** Exchange deposit addresses are not registered with Rings. Unshield to them.

## What a transfer does not hide

> [!GHOST] The wallets are visible
> Anyone can see that your wallet and the recipient's wallet took part in a private transaction, and when. This is the Default Ring: confidential, not anonymous.

Amounts and timing elsewhere can also give things away. If a wallet shields 5,000,000 of a token in public and makes a private transfer a minute later, the token and a ceiling on the amount are easy to guess. Leaving time between a crossing and a transfer helps.

## Sending between your own wallets

It works like any other transfer: the second wallet registers once, then you send to its address, or press its button under the address field. The chain shows that the two wallets dealt with each other, so this does not separate them. See [Several wallets](/docs/wallets).
