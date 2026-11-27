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

/// Candidate protocol constants. Amounts are integer token base units.
pub const MIN_CURVE_BASE: u64 = 1_000;
pub const MIN_VIRTUAL_QUOTE: u64 = 1_000;
pub const MAX_FEE_BPS: u16 = 100;
pub const CURVE: u8 = 0;
pub const READY: u8 = 1;
pub const POOL: u8 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketError { InvalidConfig, WrongPhase, Overflow, InvalidAmount, Slippage, ReserveFloor, Stale, Expired, InvalidLiquidity, Quote(QuoteError) }
impl From<QuoteError> for MarketError { fn from(v: QuoteError) -> Self { Self::Quote(v) } }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarketState {
    pub phase: u8,
    pub version: u64,
    pub base: u64,
    pub quote: u64,
    pub virtual_quote: u64,
    pub graduation_quote: u64,
    pub fee_bps: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SwapResult { pub next: MarketState, pub amount_out: u64, pub fee: u64 }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Graduation { pub next: MarketState, pub base_to_burn: u64, pub locked_lp: u64 }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Liquidity { pub next: MarketState, pub base_amount: u64, pub quote_amount: u64, pub shares: u64 }

fn narrow(v: u128) -> Result<u64, MarketError> { u64::try_from(v).map_err(|_| MarketError::Overflow) }
fn mul_div(a: u64, b: u64, d: u64) -> Result<u64, MarketError> {
    if d == 0 { return Err(MarketError::InvalidAmount); }
    narrow(u128::from(a)*u128::from(b)/u128::from(d))
}
fn mul_div_ceil(a: u64, b: u64, d: u64) -> Result<u64, MarketError> {
    if d == 0 { return Err(MarketError::InvalidAmount); }
    let n = u128::from(a)*u128::from(b);
    let d = u128::from(d);
    narrow(n/d + if n%d == 0 { 0 } else { 1 })
}
/// floor sqrt via binary search with no overflowing multiply.
pub fn sqrt_u128(n: u128) -> u64 {
    let mut lo = 0u64;
    let mut hi = u64::MAX;
    while lo < hi {
        let mid = lo + (hi-lo)/2 + 1;
        if u128::from(mid)*u128::from(mid) <= n { lo = mid; } else { hi = mid-1; }
    }
    lo
}
impl MarketState {
    pub fn new(supply: u64, virtual_quote: u64, graduation_quote: u64, fee_bps: u16) -> Result<Self, MarketError> {
        if supply < MIN_CURVE_BASE*2 || virtual_quote < MIN_VIRTUAL_QUOTE || graduation_quote < virtual_quote || fee_bps > MAX_FEE_BPS || graduation_quote.checked_add(virtual_quote).is_none() { return Err(MarketError::InvalidConfig); }
        // Exclude configurations whose virtual-reserve ratio makes the graduation floor mathematically unreachable even before rounding/fees.
        let effective_at_target = u128::from(graduation_quote) + u128::from(virtual_quote);
        if u128::from(supply)*u128::from(virtual_quote) < u128::from(MIN_CURVE_BASE)*effective_at_target { return Err(MarketError::InvalidConfig); }
        Ok(Self { phase: CURVE, version: 0, base: supply, quote: 0, virtual_quote, graduation_quote, fee_bps })
    }
    pub fn guard(&self, expected_version: u64, deadline_slot: u64, current_slot: u64) -> Result<(), MarketError> {
        if expected_version != self.version { return Err(MarketError::Stale); }
        if deadline_slot < current_slot { return Err(MarketError::Expired); }
        Ok(())
    }
    fn bump(&mut self) -> Result<(), MarketError> { self.version = self.version.checked_add(1).ok_or(MarketError::Overflow)?; Ok(()) }
    pub fn swap(&self, buy: bool, amount_in: u64, minimum_out: u64) -> Result<SwapResult, MarketError> {
        if self.phase != CURVE && self.phase != POOL { return Err(MarketError::WrongPhase); }
        let v = if self.phase == CURVE { self.virtual_quote } else { 0 };
        let (reserve_in,reserve_out,virtual_in,virtual_out) = if buy {(self.quote,self.base,v,0)}else{(self.base,self.quote,0,v)};
        let q = quote_exact_in(QuoteInput { reserve_in,reserve_out,virtual_in,virtual_out,amount_in,fee_bps:u64::from(self.fee_bps),minimum_out })?;
        let mut next = *self;
        if buy { next.quote = q.next_reserve_in; next.base = q.next_reserve_out; }
        else { next.base = q.next_reserve_in; next.quote = q.next_reserve_out; }
        if next.phase == CURVE {
            if next.base < MIN_CURVE_BASE { return Err(MarketError::ReserveFloor); }
            if next.quote >= next.graduation_quote { next.phase = READY; }
        }
        next.bump()?;
        Ok(SwapResult {next,amount_out:q.amount_out,fee:q.fee})
    }
    /// Drop the virtual quote reserve while approximately preserving the terminal marginal price.
    /// All surplus *unsold* base inventory is burned, never allocated to an issuer.
    pub fn graduate(&self) -> Result<Graduation, MarketError> {
        if self.phase != READY { return Err(MarketError::WrongPhase); }
        if self.base < MIN_CURVE_BASE || self.quote < self.graduation_quote || self.quote < self.virtual_quote { return Err(MarketError::InvalidConfig); }
        let effective = self.quote.checked_add(self.virtual_quote).ok_or(MarketError::Overflow)?;
        let pool_base = mul_div(self.base,self.quote,effective)?;
        if pool_base == 0 || pool_base > self.base { return Err(MarketError::ReserveFloor); }
        let locked_lp = sqrt_u128(u128::from(pool_base)*u128::from(self.quote));
        if locked_lp == 0 { return Err(MarketError::InvalidLiquidity); }
        let mut next = *self; next.phase = POOL; next.base = pool_base; next.bump()?;
        Ok(Graduation {next,base_to_burn:self.base-pool_base,locked_lp})
    }
    pub fn add_liquidity(&self, supply: u64, max_base: u64, max_quote: u64, min_shares: u64) -> Result<Liquidity, MarketError> {
        if self.phase != POOL { return Err(MarketError::WrongPhase); }
        if supply == 0 || self.base == 0 || self.quote == 0 || max_base == 0 || max_quote == 0 || min_shares == 0 { return Err(MarketError::InvalidLiquidity); }
        // Calculate in u128 before taking the smaller side, to avoid rejecting a valid smaller side.
        let by_base = u128::from(max_base)*u128::from(supply)/u128::from(self.base);
        let by_quote = u128::from(max_quote)*u128::from(supply)/u128::from(self.quote);
        let shares = narrow(by_base.min(by_quote))?;
        if shares < min_shares || shares == 0 { return Err(MarketError::Slippage); }
        supply.checked_add(shares).ok_or(MarketError::Overflow)?;
        let base_amount = mul_div_ceil(shares,self.base,supply)?;
        let quote_amount = mul_div_ceil(shares,self.quote,supply)?;
        if base_amount > max_base || quote_amount > max_quote { return Err(MarketError::Slippage); }
        let mut next = *self;
        next.base = next.base.checked_add(base_amount).ok_or(MarketError::Overflow)?;
        next.quote = next.quote.checked_add(quote_amount).ok_or(MarketError::Overflow)?;
        next.bump()?;
        Ok(Liquidity {next,base_amount,quote_amount,shares})
    }
    pub fn remove_liquidity(&self, supply: u64, locked: u64, shares: u64, min_base: u64, min_quote: u64) -> Result<Liquidity, MarketError> {
        if self.phase != POOL { return Err(MarketError::WrongPhase); }
        if locked == 0 || supply < locked || shares == 0 || shares > supply-locked || min_base == 0 || min_quote == 0 { return Err(MarketError::InvalidLiquidity); }
        let base_amount = mul_div(shares,self.base,supply)?;
        let quote_amount = mul_div(shares,self.quote,supply)?;
        if base_amount < min_base || quote_amount < min_quote { return Err(MarketError::Slippage); }
        let mut next = *self;
        next.base = next.base.checked_sub(base_amount).ok_or(MarketError::Overflow)?;
        next.quote = next.quote.checked_sub(quote_amount).ok_or(MarketError::Overflow)?;
        if next.base == 0 || next.quote == 0 { return Err(MarketError::ReserveFloor); }
        next.bump()?;
        Ok(Liquidity {next,base_amount,quote_amount,shares})
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    fn initial() -> MarketState { MarketState::new(1_000_000,100_000,200_000,30).unwrap() }
    #[test] fn lifecycle_and_rounding() {
        let a = initial();
        let b = a.swap(true,50_000,1).unwrap();
        assert_eq!(b.amount_out,332_665);
        assert_eq!(b.next.phase,CURVE);
        let c = b.next.swap(true,150_000,1).unwrap().next;
        assert_eq!(c.phase,READY);
        assert!(c.swap(true,100,1).is_err());
        let d = c.graduate().unwrap();
        assert_eq!(d.next.phase,POOL);
        assert_eq!(d.next.base+d.base_to_burn,c.base);
        assert!(d.next.graduate().is_err());
        let add = d.next.add_liquidity(d.locked_lp,50_000,50_000,1).unwrap();
        let rem = add.next.remove_liquidity(d.locked_lp+add.shares,d.locked_lp,add.shares,1,1).unwrap();
        assert!(rem.base_amount<=add.base_amount && rem.quote_amount<=add.quote_amount);
        assert!(rem.next.base>=d.next.base && rem.next.quote>=d.next.quote);
    }
    #[test] fn reject_stale_expired_and_early_graduation() {
        let a=initial();
        assert_eq!(a.guard(1,100,90),Err(MarketError::Stale));
        assert_eq!(a.guard(0,89,90),Err(MarketError::Expired));
        assert!(a.graduate().is_err());
        assert!(a.swap(false,100,1).is_err());
        assert!(MarketState::new(2_000,100_000,200_000,0).is_err());
    }
    #[test] fn sqrt_bounds() {
        for x in [0u128,1,2,3,4,9,10,u128::MAX] { let y=sqrt_u128(x); assert!(u128::from(y)*u128::from(y)<=x); if y<u64::MAX {assert!(u128::from(y+1)*u128::from(y+1)>x);} }
    }
    #[test] fn fixture_vectors() {
        // Generated by the independent BigInt implementation and checked into the source tree.
        let data=include_str!("../../../reference/lifecycle-vectors.csv");
        for line in data.lines().skip(1).filter(|l| !l.is_empty()) {
            let v:Vec<u64>=line.split(',').map(|x|x.parse().unwrap()).collect();
            let a=MarketState::new(v[0],v[1],v[2],v[3] as u16).unwrap();
            let s=a.swap(true,v[4],1).unwrap();
            assert_eq!((s.amount_out,s.fee,s.next.base,s.next.quote,u64::from(s.next.phase)),(v[5],v[6],v[7],v[8],v[9]));
            let g=s.next.graduate().unwrap();
            assert_eq!((g.next.base,g.base_to_burn,g.locked_lp),(v[10],v[11],v[12]));
            let l=g.next.add_liquidity(g.locked_lp,v[13],v[14],1).unwrap();
            assert_eq!((l.shares,l.base_amount,l.quote_amount),(v[15],v[16],v[17]));
            let r=l.next.remove_liquidity(g.locked_lp+l.shares,g.locked_lp,l.shares,1,1).unwrap();
            assert_eq!((r.base_amount,r.quote_amount,r.next.base,r.next.quote),(v[18],v[19],v[20],v[21]));
        }
    }
}
