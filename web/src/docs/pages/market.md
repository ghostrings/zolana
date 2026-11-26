The [Market](/) lists every token launched on this site, {{page_size}} to a page.

## The strip above the list

Four figures run across the top: how many tokens are listed, how much the curves hold, how much has been traded here in all, and how many tokens have graduated. **Total volume** counts every token from its launch, on its curve and after it. The amounts are in SOL terms. With more than one [pair token](/docs/pairs) in use they are marked with `≈`, because tokens priced in another pair are counted at a fixed rate and not at a live price.

When at least four tokens are listed, the most traded ones also run along a thin strip under the header. It stops while the pointer is over it. If your device asks for less motion it does not run at all, and can be dragged sideways instead.

A phone has neither the title nor the running strip. It shows the four figures and then the tokens.

## Three layouts

The switch at the right of the controls changes how the same tokens are laid out.

| Layout | What it is |
| --- | --- |
| Cards | One card to a token, with everything this page knows about it. |
| Grid | Small tiles, so more tokens fit on a screen. |
| Table | One row to a token, with a column for each figure. On a narrow screen the less important columns are left out. |

On a phone the table is a list of strips. Each has the artwork, the ticker, the name, the small chart, and the market cap over the 24-hour change. The line under a strip is its progress to graduation: the further along the curve, the longer the lit part. The same progress is written before the name, as a percentage or as **Migrating** or **Graduated**.

Your choice is kept in this browser. A phone starts on the table, a wider screen on cards.

## Ordering

| Order | What comes first |
| --- | --- |
| Trending | The most traded over the last 24 hours. Tokens that did not trade in that time follow, the most traded since launch first. |
| New | The most recently launched. |
| Volume | The most traded since launch. |
| Market cap | The highest price times current supply. |
| Graduating | The curves closest to their target. |

In the table, the headings **Market cap**, **Total volume**, **Graduation** and **Age** set the same orders. On a phone the **Market cap** order is written **Cap**.

Tokens priced in different [pair tokens](/docs/pairs) are compared at a fixed rate against SOL, not at live prices, so across pairs the order by size and by volume is approximate. When more than one pair is in use, a row of pair buttons next to the order narrows the list to one of them. On a narrow screen the order and the pairs share one row that scrolls sideways; the edge that fades has more behind it.

## Searching

Type a ticker, part of a name, or the beginning of a mint address. The search covers the whole list, not just the page on screen, and it ignores capital letters. Pressing `/` puts the cursor in the search box.

## Pages

The list never shows more than {{page_size}} tokens at once. Under it, the pager has **Prev** and **Next**, the page numbers, and a line that says which tokens you are looking at, for example `Page 2 of 3 · 25–48 of 57`.

The address bar follows what you see. A page, an order and a search can all be bookmarked or shared, and the browser's Back button steps back through the pages and orders you chose.

## What a card shows

- The artwork, the ticker and the name.
- What it is priced in, as a small mark under the ticker. Every amount on the card is in that [pair token](/docs/pairs).
- The change in price over the last 24 hours. A rise is a filled mark with a triangle pointing up; a fall is a hollow mark with a triangle pointing down. For a token launched less than a day ago it is the change since launch.
- A small chart of the price over the same stretch of time.
- Market cap, total volume and price. The volume is everything traded since the token's launch, not the last day's. A very small price is written short: `0.0₆113` is a zero, a point, six more zeros and then 113. A large amount is written short as well: `79.7K` is 79,700 and `1.23M` is 1,230,000. Where a card is narrow the volume is written without its pair token, which stands beside the market cap. A token's own page writes its spot price the same short way; the chart beside it has every digit.
- Progress to graduation, as a line with a marker on it. A token that has left its curve says **Migrating** or **Graduated** instead of a percentage.
- The fee tier. A token whose creator fees run through [fee modules](/docs/fee-modules) says so, and a token with burned supply says how much.
- How long ago it was launched.

Artwork is shown in black and white in the list and in colour under the pointer. On the token's own page it is always in colour.

The list refreshes about every 15 seconds while the tab is visible. Figures change in place, and one that moved is lit for a moment.

## Where the numbers come from

Prices, reserves and supply are read from chain: the Meteora pool and the token's mint.

Volume is worked out from fees. A token's fee is one rate for its whole life and is always taken in its pair token, so the fees its curve and its pool have collected, divided by that rate, are what has been traded. Both pools keep that count on chain from the first trade, the creator's first buy included, so the total is right for a token however late this site first saw it, and it keeps counting through graduation. It is cut off, not rounded up. The order called Trending uses the same count over the last 24 hours, which does come from this server's own records. The chart and the 24-hour change come from price points this site's server records for each token, one every five minutes and more often while the price is moving.

## Why there are no holder counts

Balances kept in Rings sit in one pooled account, and who owns what inside it is encrypted. Any holder count would only count the wallets that hold a token the ordinary, public way, and would be wrong. So none is shown.

## What is listed

Only tokens launched on one of this platform's three fee tiers. A token made on other terms does not appear, even if it trades on Meteora.
