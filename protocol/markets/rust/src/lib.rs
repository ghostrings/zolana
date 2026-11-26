//! Public market quote arithmetic. No Solana instruction processor or fund movement.
//! Fee is rounded up and retained in the input reserve; output is rounded down.
#![forbid(unsafe_code)]

const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QuoteInput {
    pub reserve_in: u64,
    pub reserve_out: u64,
    pub virtual_in: u64,
    pub virtual_out: u64,
    pub amount_in: u64,
    pub fee_bps: u64,
    pub minimum_out: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Quote {
    pub amount_in: u64,
    pub fee: u64,
    pub net: u64,
    pub amount_out: u64,
    pub next_reserve_in: u64,
    pub next_reserve_out: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuoteError {
    InvalidInput,
    InvalidFee,
    Overflow,
    FeeConsumesInput,
    MinimumOutput,
    InsufficientRealReserve,
    Invariant,
}

pub fn quote_exact_in(i: QuoteInput) -> Result<Quote, QuoteError> {
    if i.amount_in == 0 || i.reserve_out == 0 || i.minimum_out == 0 {
        return Err(QuoteError::InvalidInput);
    }
    if u128::from(i.fee_bps) >= BPS {
        return Err(QuoteError::InvalidFee);
    }
    let x = i.reserve_in.checked_add(i.virtual_in).ok_or(QuoteError::Overflow)?;
    let y = i.reserve_out.checked_add(i.virtual_out).ok_or(QuoteError::Overflow)?;
    if x == 0 {
        return Err(QuoteError::InvalidInput);
    }
    // u64 * fee_bps < u128::MAX. Products of two u64 values fit in u128.
    let fee = u64::try_from((u128::from(i.amount_in) * u128::from(i.fee_bps) + BPS - 1) / BPS)
        .map_err(|_| QuoteError::Overflow)?;
    let net = i.amount_in.checked_sub(fee).ok_or(QuoteError::Overflow)?;
    if net == 0 {
        return Err(QuoteError::FeeConsumesInput);
    }
    let denominator = x.checked_add(net).ok_or(QuoteError::Overflow)?;
    let amount_out = u64::try_from(u128::from(y) * u128::from(net) / u128::from(denominator))
        .map_err(|_| QuoteError::Overflow)?;
    if amount_out == 0 || amount_out < i.minimum_out {
        return Err(QuoteError::MinimumOutput);
    }
    if amount_out >= i.reserve_out {
        return Err(QuoteError::InsufficientRealReserve);
    }
    let next_reserve_in = i.reserve_in.checked_add(i.amount_in).ok_or(QuoteError::Overflow)?;
    let next_reserve_out = i.reserve_out - amount_out;
    let next_x = next_reserve_in.checked_add(i.virtual_in).ok_or(QuoteError::Overflow)?;
    let next_y = next_reserve_out.checked_add(i.virtual_out).ok_or(QuoteError::Overflow)?;
    if u128::from(next_x) * u128::from(next_y) < u128::from(x) * u128::from(y) {
        return Err(QuoteError::Invariant);
    }
    Ok(Quote { amount_in: i.amount_in, fee, net, amount_out, next_reserve_in, next_reserve_out })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> QuoteInput {
        QuoteInput { reserve_in: 1000, reserve_out: 1000, virtual_in: 0, virtual_out: 0, amount_in: 100, fee_bps: 0, minimum_out: 1 }
    }
    #[test]
    fn exact_input() {
        assert_eq!(quote_exact_in(base()), Ok(Quote { amount_in: 100, fee: 0, net: 100, amount_out: 90, next_reserve_in: 1100, next_reserve_out: 910 }));
    }
    #[test]
    fn fee_rounding() {
        assert_eq!(quote_exact_in(QuoteInput { fee_bps: 30, ..base() }), Ok(Quote { amount_in: 100, fee: 1, net: 99, amount_out: 90, next_reserve_in: 1100, next_reserve_out: 910 }));
    }
    #[test]
    fn reject_invalid_amounts_and_fee() {
        assert_eq!(quote_exact_in(QuoteInput { amount_in: 0, ..base() }), Err(QuoteError::InvalidInput));
        assert_eq!(quote_exact_in(QuoteInput { minimum_out: 0, ..base() }), Err(QuoteError::InvalidInput));
        assert_eq!(quote_exact_in(QuoteInput { fee_bps: 10_000, ..base() }), Err(QuoteError::InvalidFee));
        assert_eq!(quote_exact_in(QuoteInput { amount_in: 1, fee_bps: 1, ..base() }), Err(QuoteError::FeeConsumesInput));
    }
    #[test]
    fn reject_dust_and_slippage() {
        assert_eq!(quote_exact_in(QuoteInput { reserve_out: 1, amount_in: 1, ..base() }), Err(QuoteError::MinimumOutput));
        assert_eq!(quote_exact_in(QuoteInput { minimum_out: 91, ..base() }), Err(QuoteError::MinimumOutput));
    }
    #[test]
    fn virtual_reserves() {
        assert_eq!(quote_exact_in(QuoteInput { reserve_in: 100, reserve_out: 10, virtual_out: 1000, ..base() }), Err(QuoteError::InsufficientRealReserve));
        assert_eq!(quote_exact_in(QuoteInput { reserve_in: 0, ..base() }), Err(QuoteError::InvalidInput));
        assert_eq!(quote_exact_in(QuoteInput { reserve_in: 0, virtual_in: 1000, ..base() }).unwrap().amount_out, 90);
    }
    #[test]
    fn overflow() {
        assert_eq!(quote_exact_in(QuoteInput { reserve_in: u64::MAX, virtual_in: 1, ..base() }), Err(QuoteError::Overflow));
        assert_eq!(quote_exact_in(QuoteInput { reserve_in: u64::MAX-2, reserve_out: u64::MAX, amount_in: 3, fee_bps: 3334, ..base() }), Err(QuoteError::Overflow));
    }
    #[test]
    fn deterministic_properties() {
        let mut seed = 42u64;
        let mut rand = || { seed = (1664525 * seed + 1013904223) & 0xffffffff; seed };
        for _ in 0..10_000 {
            let x = 10_000 + rand() % 1_000_000;
            let y = 10_000 + rand() % 1_000_000;
            let input = 100 + rand() % 100_000;
            let fee_bps = rand() % 101;
            let q = quote_exact_in(QuoteInput { reserve_in: x, reserve_out: y, amount_in: input, fee_bps, ..base() }).unwrap();
            assert!(q.amount_out > 0 && q.amount_out < y);
            assert_eq!(q.net + q.fee, input);
            assert_eq!(q.next_reserve_in, x + input);
            assert_eq!(q.next_reserve_out, y - q.amount_out);
            assert!(u128::from(q.next_reserve_in) * u128::from(q.next_reserve_out) >= u128::from(x) * u128::from(y));
            assert_eq!(u128::from(q.amount_out), u128::from(y) * u128::from(q.net) / u128::from(x + q.net));
        }
    }
}
