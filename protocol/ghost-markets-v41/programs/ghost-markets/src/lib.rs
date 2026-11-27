//! V41 permissionless native launch candidate; compatible V33 accounts. Public SPL only.
//! Default build is locked. `public-v41` is a separate restricted review candidate.
//! Never deploy a local-market-testing artifact. No feature combination is permitted.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, spl_token::instruction::AuthorityType, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount, TransferChecked};
use ghost_market_math::{MarketState, MarketError, CURVE, POOL, NATIVE_FEE_TIERS, native_fee_split};

// Public disclosure only. The security contact is a URL, not an embedded credential.
// This is not a claim of an audit, affiliation, or verified new deployment.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "GHOST Markets",
    project_url: "https://privacycash.fun",
    contacts: "link:https://github.com/ghostrings/zolana/security",
    policy: "https://github.com/ghostrings/zolana/blob/main/SECURITY.md",
    source_code: "https://github.com/ghostrings/zolana",
    preferred_languages: "en"
}

// Source placeholder; replace with a fresh local/development deployment key via anchor keys sync.
declare_id!("FQ9qkZv3nBnDubM5oznc4kF2LzzTA7i5xsmBkC6hAWbg");

#[program]
pub mod ghost_markets {
    use super::*;

    /// The actual upgrade authority must bootstrap the unique config PDA.
    /// Initialization never admits assets, including in the local test build.
    pub fn initialize_protocol(ctx: Context<InitializeProtocol>, pauser: Pubkey) -> Result<()> {
        let treasury = ctx.accounts.treasury.key();
        require!(pauser != Pubkey::default() && treasury != Pubkey::default()
            && treasury != ctx.accounts.authority.key() && treasury != pauser, ErrorCode::ProtocolAuthority);
        let config = &mut ctx.accounts.protocol;
        config.schema = 2;
        config.bump = ctx.bumps.protocol;
        config.mode = LOCKED;
        config.admin = ctx.accounts.authority.key();
        config.pauser = pauser;
        config.pending_admin = Pubkey::default();
        config.treasury = treasury;
        emit!(ProtocolModeChanged { previous: LOCKED, next: LOCKED, authority: config.admin });
        Ok(())
    }

    pub fn set_protocol_mode(ctx: Context<ManageProtocol>, next: u8) -> Result<()> {
        let config = &mut ctx.accounts.protocol;
        config.check_schema()?;
        let signer = ctx.accounts.authority.key();
        // The default release binary cannot be activated by any signer.
        require!(EXECUTION_ENABLED, ErrorCode::ExecutionDisabled);
        match (config.mode, next) {
            (LOCKED, ACTIVE) | (PAUSED, ACTIVE) => {
                require!(signer == config.admin, ErrorCode::ProtocolAuthority);
            }
            (ACTIVE, PAUSED) => {
                require!(signer == config.admin || signer == config.pauser, ErrorCode::ProtocolAuthority);
            }
            _ => return err!(ErrorCode::ProtocolTransition),
        }
        let previous = config.mode;
        config.mode = next;
        emit!(ProtocolModeChanged { previous, next, authority: signer });
        Ok(())
    }

    pub fn nominate_admin(ctx: Context<ManageProtocol>, nominee: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.protocol;
        config.check_schema()?;
        require_keys_eq!(ctx.accounts.authority.key(), config.admin, ErrorCode::ProtocolAuthority);
        require!(nominee != config.treasury, ErrorCode::ProtocolAuthority);
        // A zero key cancels a pending nomination; acceptance always requires a signer.
        config.pending_admin = nominee;
        emit!(ProtocolAdminNominated { current: config.admin, nominee });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<ManageProtocol>) -> Result<()> {
        let config = &mut ctx.accounts.protocol;
        config.check_schema()?;
        require!(config.pending_admin != Pubkey::default() && config.pending_admin != config.treasury && ctx.accounts.authority.key() == config.pending_admin, ErrorCode::ProtocolAuthority);
        let previous = config.admin;
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        emit!(ProtocolAdminChanged { previous, next: config.admin });
        Ok(())
    }

    pub fn set_pauser(ctx: Context<ManageProtocol>, pauser: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.protocol;
        config.check_schema()?;
        require_keys_eq!(ctx.accounts.authority.key(), config.admin, ErrorCode::ProtocolAuthority);
        require!(pauser != Pubkey::default() && pauser != config.treasury, ErrorCode::ProtocolAuthority);
        let previous = config.pauser;
        config.pauser = pauser;
        emit!(ProtocolPauserChanged { previous, next: pauser });
        Ok(())
    }

    pub fn create_market(ctx: Context<CreateMarket>, nonce: u64, args: CreateArgs) -> Result<()> {
        ctx.accounts.protocol.require_operation(false)?;
        require!(!args.name.is_empty() && args.name.len() <= 32 && !args.name.chars().any(char::is_control), ErrorCode::Metadata);
        require!(!args.symbol.is_empty() && args.symbol.len() <= 10 && args.symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()), ErrorCode::Metadata);
        require!(args.metadata_uri.len() <= 200 && !args.metadata_uri.chars().any(char::is_control), ErrorCode::Metadata);
        // Original SPL Token only. A quote mint with freeze authority could stop exits.
        require!(ctx.accounts.quote_mint.freeze_authority.is_none(), ErrorCode::UnsupportedQuote);
        if PUBLIC_PILOT {
            // Permissionless public launches. Creator alone signs and pays rent.
            require!(ctx.remaining_accounts.is_empty(), ErrorCode::ProtocolAuthority);
            require_keys_eq!(ctx.accounts.quote_mint.key(), anchor_spl::token::spl_token::native_mint::ID, ErrorCode::UnsupportedQuote);
            require!(args.supply == PILOT_SUPPLY && args.virtual_quote == V41_VIRTUAL_QUOTE
                && args.graduation_quote == V41_GRADUATION_QUOTE && NATIVE_FEE_TIERS.contains(&args.fee_bps),
                ErrorCode::PilotProfile);
        }
        let state = if PUBLIC_PILOT {
            math(MarketState::new_native(args.supply, args.virtual_quote, args.graduation_quote, args.fee_bps))?
        } else { math(MarketState::new(args.supply, args.virtual_quote, args.graduation_quote, args.fee_bps))? };
        let a = ctx.accounts;
        let m = &mut a.market;
        m.schema = 2;
        m.bump = ctx.bumps.market;
        m.creator = a.creator.key();
        m.nonce = nonce;
        m.base_mint = a.base_mint.key();
        m.quote_mint = a.quote_mint.key();
        m.lp_mint = a.lp_mint.key();
        m.base_vault = a.base_vault.key();
        m.quote_vault = a.quote_vault.key();
        m.lp_lock = a.lp_lock.key();
        m.initial_supply = args.supply;
        m.burned_at_graduation = 0;
        m.locked_lp = 0;
        // Pin the separately accepted treasury, not the launch approver.
        m.platform = a.protocol.treasury;
        m.platform_fee_quote = 0;
        m.creator_fee_quote = 0;
        m.name = args.name;
        m.symbol = args.symbol;
        m.metadata_uri = args.metadata_uri;
        m.apply(state);
        let nonce_bytes = m.nonce.to_le_bytes();
        let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"market", m.creator.as_ref(), &nonce_bytes, &bump];
        let signers = &[seeds];
        // The complete supply goes to the market vault; no creator or operator allocation.
        token::mint_to(CpiContext::new_with_signer(a.token_program.to_account_info(), MintTo {
            mint: a.base_mint.to_account_info(), to: a.base_vault.to_account_info(), authority: m.to_account_info(),
        }, signers), args.supply)?;
        // Permanently revoke the base mint authority in the same transaction.
        token::set_authority(CpiContext::new_with_signer(a.token_program.to_account_info(), SetAuthority {
            account_or_mint: a.base_mint.to_account_info(), current_authority: m.to_account_info(),
        }, signers), AuthorityType::MintTokens, None)?;
        emit!(MarketCreated { market: m.key(), creator: m.creator, base_mint: m.base_mint, quote_mint: m.quote_mint,
            initial_supply: m.initial_supply, creator_premint: 0, virtual_quote: m.virtual_quote, graduation_quote: m.graduation_quote, fee_bps: m.fee_bps });
        Ok(())
    }

    pub fn swap(ctx: Context<Swap>, buy: bool, amount_in: u64, minimum_out: u64, expected_version: u64, deadline_slot: u64) -> Result<()> {
        ctx.accounts.protocol.require_operation(swap_allowed_while_paused(buy, ctx.accounts.market.phase))?;
        let a = ctx.accounts;
        let m = &mut a.market;
        let s = m.checked_state(&a.base_vault, &a.quote_vault, expected_version, deadline_slot)?;
        let q = if PUBLIC_PILOT { math(s.swap_native(buy, amount_in, minimum_out))? }
            else { math(s.swap(buy, amount_in, minimum_out))? };
        let (platform_fee, creator_fee) = if PUBLIC_PILOT { math(native_fee_split(s.phase,q.fee))? } else { (0,0) };
        let platform_owed = m.platform_fee_quote.checked_add(platform_fee).ok_or(ErrorCode::Overflow)?;
        let creator_owed = m.creator_fee_quote.checked_add(creator_fee).ok_or(ErrorCode::Overflow)?;
        // Cap quote principal + accrued fees. A buy may not grow obligations above the pilot cap.
        if PUBLIC_PILOT && buy {
            let cap = native_profile_cap(m.initial_supply, m.virtual_quote, m.graduation_quote)?;
            // Preserve the existing V33 market cap and graduation behavior. New markets
            // cannot overshoot the disclosed graduation reserve with a single large buy.
            if m.graduation_quote == V41_GRADUATION_QUOTE && s.phase == CURVE {
                require!(q.next.quote <= m.graduation_quote, ErrorCode::GraduationOvershoot);
            }
            require!(q.next.quote.checked_add(platform_owed).and_then(|n| n.checked_add(creator_owed)).ok_or(ErrorCode::Overflow)? <= cap, ErrorCode::PilotCap);
        }
        // Limit accounted quote exposure per market; never impose the cap on exits.

        let nonce = m.nonce.to_le_bytes(); let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"market", m.creator.as_ref(), &nonce, &bump]; let signers = &[seeds];
        let tp = a.token_program.to_account_info();
        let user = a.trader.to_account_info(); let authority = m.to_account_info();
        if buy {
            checked_transfer(tp.clone(), a.user_quote.to_account_info(), a.quote_mint.to_account_info(), a.quote_vault.to_account_info(), user, &[], amount_in, a.quote_mint.decimals)?;
            checked_transfer(tp, a.base_vault.to_account_info(), a.base_mint.to_account_info(), a.user_base.to_account_info(), authority, signers, q.amount_out, a.base_mint.decimals)?;
        } else {
            checked_transfer(tp.clone(), a.user_base.to_account_info(), a.base_mint.to_account_info(), a.base_vault.to_account_info(), user, &[], amount_in, a.base_mint.decimals)?;
            checked_transfer(tp, a.quote_vault.to_account_info(), a.quote_mint.to_account_info(), a.user_quote.to_account_info(), authority, signers, q.amount_out, a.quote_mint.decimals)?;
        }
        // No accounting mutation is committed if any CPI fails; Solana transactions are atomic.
        m.platform_fee_quote = platform_owed;
        m.creator_fee_quote = creator_owed;
        m.apply(q.next);
        emit!(SwapExecuted { market: m.key(), trader: a.trader.key(), buy, amount_in, amount_out: q.amount_out, fee: q.fee,
            base_reserve: m.base_reserve, quote_reserve: m.quote_reserve, phase: m.phase, version: m.version });
        if PUBLIC_PILOT { emit!(NativeFeeAccrued {market:m.key(), quote_mint:m.quote_mint, phase:s.phase, platform_fee, creator_fee}); }
        Ok(())
    }

    /// Claim only the caller's accrued quote fees. Never spend curve/pool reserves or locked LP.
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        ctx.accounts.protocol.require_operation(true)?;
        require!(PUBLIC_PILOT, ErrorCode::ExecutionDisabled);
        let a = ctx.accounts;
        let m = &mut a.market;
        require!(m.schema == 2, ErrorCode::Schema);
        m.check_quote(&a.quote_vault)?;
        let recipient = a.recipient.key();
        let is_platform = recipient == m.platform;
        require!(is_platform || recipient == m.creator, ErrorCode::ProtocolAuthority);
        // If the same wallet creates a market and is also the treasury, preserve both
        // fee entitlements. No other signer may claim or redirect either ledger.
        let is_creator = recipient == m.creator;
        let platform_amount = if is_platform { m.platform_fee_quote } else { 0 };
        let creator_amount = if is_creator { m.creator_fee_quote } else { 0 };
        let amount = platform_amount.checked_add(creator_amount).ok_or(ErrorCode::Overflow)?;
        require!(amount > 0, ErrorCode::InvalidAmount);
        let nonce = m.nonce.to_le_bytes(); let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"market", m.creator.as_ref(), &nonce, &bump]; let signers = &[seeds];
        checked_transfer(a.token_program.to_account_info(), a.quote_vault.to_account_info(), a.quote_mint.to_account_info(), a.destination.to_account_info(), m.to_account_info(), signers, amount, a.quote_mint.decimals)?;
        if is_platform { m.platform_fee_quote = 0; }
        if is_creator { m.creator_fee_quote = 0; }
        if platform_amount > 0 { emit!(NativeFeeClaimed {market:m.key(), recipient, amount:platform_amount, is_platform:true}); }
        if creator_amount > 0 { emit!(NativeFeeClaimed {market:m.key(), recipient, amount:creator_amount, is_platform:false}); }
        Ok(())
    }

    pub fn graduate(ctx: Context<Graduate>, expected_version: u64, deadline_slot: u64) -> Result<()> {
        ctx.accounts.protocol.require_operation(true)?;
        let a = ctx.accounts;
        let m = &mut a.market;
        let s = m.checked_state(&a.base_vault, &a.quote_vault, expected_version, deadline_slot)?;
        require!(m.locked_lp == 0 && a.lp_mint.supply == 0 && a.lp_lock.amount == 0, ErrorCode::LpAccounting);
        let g = math(s.graduate())?;
        let nonce = m.nonce.to_le_bytes(); let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"market", m.creator.as_ref(), &nonce, &bump]; let signers = &[seeds];
        if g.base_to_burn > 0 {
            token::burn(CpiContext::new_with_signer(a.token_program.to_account_info(), Burn {
                mint: a.base_mint.to_account_info(), from: a.base_vault.to_account_info(), authority: m.to_account_info(),
            }, signers), g.base_to_burn)?;
        }
        // Initial LP shares are locked in a PDA vault. No instruction spends or closes it.
        token::mint_to(CpiContext::new_with_signer(a.token_program.to_account_info(), MintTo {
            mint: a.lp_mint.to_account_info(), to: a.lp_lock.to_account_info(), authority: m.to_account_info(),
        }, signers), g.locked_lp)?;
        m.locked_lp = g.locked_lp;
        m.burned_at_graduation = g.base_to_burn;
        m.apply(g.next);
        emit!(Graduated { market: m.key(), burned_unsold_base: g.base_to_burn, genesis_locked_lp: g.locked_lp,
            base_reserve: m.base_reserve, quote_reserve: m.quote_reserve, version: m.version });
        Ok(())
    }

    pub fn add_liquidity(ctx: Context<LiquidityChange>, max_base: u64, max_quote: u64, min_shares: u64, expected_version: u64, deadline_slot: u64) -> Result<()> {
        ctx.accounts.protocol.require_operation(false)?;
        require!(!PUBLIC_PILOT, ErrorCode::LockedLiquidityOnly);
        let a = ctx.accounts;
        let m = &mut a.market;
        let s = m.checked_state(&a.base_vault, &a.quote_vault, expected_version, deadline_slot)?;
        m.check_lp(&a.lp_mint, &a.lp_lock)?;
        let l = math(s.add_liquidity(a.lp_mint.supply, max_base, max_quote, min_shares))?;
        let nonce = m.nonce.to_le_bytes(); let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"market", m.creator.as_ref(), &nonce, &bump]; let signers = &[seeds];
        let tp = a.token_program.to_account_info(); let user = a.provider.to_account_info();
        checked_transfer(tp.clone(), a.user_base.to_account_info(), a.base_mint.to_account_info(), a.base_vault.to_account_info(), user.clone(), &[], l.base_amount, a.base_mint.decimals)?;
        checked_transfer(tp.clone(), a.user_quote.to_account_info(), a.quote_mint.to_account_info(), a.quote_vault.to_account_info(), user, &[], l.quote_amount, a.quote_mint.decimals)?;
        token::mint_to(CpiContext::new_with_signer(tp, MintTo {
            mint: a.lp_mint.to_account_info(), to: a.user_lp.to_account_info(), authority: m.to_account_info(),
        }, signers), l.shares)?;
        m.apply(l.next);
        emit!(LiquidityChanged { market: m.key(), provider: a.provider.key(), add: true, base_amount: l.base_amount, quote_amount: l.quote_amount, shares: l.shares, version: m.version });
        Ok(())
    }

    pub fn remove_liquidity(ctx: Context<LiquidityChange>, shares: u64, min_base: u64, min_quote: u64, expected_version: u64, deadline_slot: u64) -> Result<()> {
        ctx.accounts.protocol.require_operation(true)?;
        require!(!PUBLIC_PILOT, ErrorCode::LockedLiquidityOnly);
        let a = ctx.accounts;
        let m = &mut a.market;
        let s = m.checked_state(&a.base_vault, &a.quote_vault, expected_version, deadline_slot)?;
        m.check_lp(&a.lp_mint, &a.lp_lock)?;
        let l = math(s.remove_liquidity(a.lp_mint.supply, a.lp_lock.amount, shares, min_base, min_quote))?;
        require!(a.user_lp.amount >= shares, ErrorCode::LpAccounting);
        let nonce = m.nonce.to_le_bytes(); let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"market", m.creator.as_ref(), &nonce, &bump]; let signers = &[seeds];
        let tp = a.token_program.to_account_info(); let authority = m.to_account_info();
        token::burn(CpiContext::new(tp.clone(), Burn {
            mint: a.lp_mint.to_account_info(), from: a.user_lp.to_account_info(), authority: a.provider.to_account_info(),
        }), shares)?;
        checked_transfer(tp.clone(), a.base_vault.to_account_info(), a.base_mint.to_account_info(), a.user_base.to_account_info(), authority.clone(), signers, l.base_amount, a.base_mint.decimals)?;
        checked_transfer(tp, a.quote_vault.to_account_info(), a.quote_mint.to_account_info(), a.user_quote.to_account_info(), authority, signers, l.quote_amount, a.quote_mint.decimals)?;
        m.apply(l.next);
        emit!(LiquidityChanged { market: m.key(), provider: a.provider.key(), add: false, base_amount: l.base_amount, quote_amount: l.quote_amount, shares: l.shares, version: m.version });
        Ok(())
    }
}

fn math<T>(result: core::result::Result<T, MarketError>) -> Result<T> {
    result.map_err(|e| match e {
        MarketError::InvalidConfig => error!(ErrorCode::InvalidConfig),
        MarketError::WrongPhase => error!(ErrorCode::WrongPhase),
        MarketError::Stale => error!(ErrorCode::StaleVersion),
        MarketError::Expired => error!(ErrorCode::Expired),
        MarketError::Overflow | MarketError::Quote(ghost_market_math::QuoteError::Overflow) => error!(ErrorCode::Overflow),
        MarketError::Slippage | MarketError::Quote(ghost_market_math::QuoteError::MinimumOutput) => error!(ErrorCode::Slippage),
        MarketError::ReserveFloor | MarketError::Quote(ghost_market_math::QuoteError::InsufficientRealReserve) => error!(ErrorCode::ReserveFloor),
        MarketError::InvalidLiquidity => error!(ErrorCode::LpAccounting),
        _ => error!(ErrorCode::InvalidAmount),
    })
}

#[allow(clippy::too_many_arguments)]
fn checked_transfer<'info>(program: AccountInfo<'info>, from: AccountInfo<'info>, mint: AccountInfo<'info>, to: AccountInfo<'info>, authority: AccountInfo<'info>, signers: &[&[&[u8]]], amount: u64, decimals: u8) -> Result<()> {
    token::transfer_checked(CpiContext::new_with_signer(program, TransferChecked { from, mint, to, authority }, signers), amount, decimals)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateArgs {
    pub name: String,
    pub symbol: String,
    pub metadata_uri: String,
    pub supply: u64,
    pub virtual_quote: u64,
    pub graduation_quote: u64,
    pub fee_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub schema: u8,
    pub bump: u8,
    pub phase: u8,
    pub creator: Pubkey,
    pub nonce: u64,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub lp_lock: Pubkey,
    pub version: u64,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    pub virtual_quote: u64,
    pub graduation_quote: u64,
    pub fee_bps: u16,
    pub initial_supply: u64,
    pub burned_at_graduation: u64,
    pub locked_lp: u64,
    pub platform: Pubkey,
    pub platform_fee_quote: u64,
    pub creator_fee_quote: u64,
    #[max_len(32)] pub name: String,
    #[max_len(10)] pub symbol: String,
    #[max_len(200)] pub metadata_uri: String,
}
impl Market {
    fn state(&self) -> MarketState { MarketState { phase: self.phase, version: self.version, base: self.base_reserve, quote: self.quote_reserve,
        virtual_quote: self.virtual_quote, graduation_quote: self.graduation_quote, fee_bps: self.fee_bps } }
    fn apply(&mut self, s: MarketState) { self.phase = s.phase; self.version = s.version; self.base_reserve = s.base; self.quote_reserve = s.quote;
        self.virtual_quote = s.virtual_quote; self.graduation_quote = s.graduation_quote; self.fee_bps = s.fee_bps; }
    fn checked_state(&self, base: &TokenAccount, quote: &TokenAccount, expected_version: u64, deadline_slot: u64) -> Result<MarketState> {
        require!(self.schema == 2, ErrorCode::Schema);
        // Unsolicited donations never alter quoted reserves or grant a withdrawal right.
        require!(base.amount >= self.base_reserve, ErrorCode::VaultAccounting);
        self.check_quote(quote)?;
        let s = self.state(); math(s.guard(expected_version, deadline_slot, Clock::get()?.slot))?; Ok(s)
    }
    fn check_quote(&self, quote: &TokenAccount) -> Result<()> {
        let owed = self.quote_reserve.checked_add(self.platform_fee_quote).and_then(|n| n.checked_add(self.creator_fee_quote)).ok_or(ErrorCode::Overflow)?;
        require!(quote.amount >= owed, ErrorCode::VaultAccounting);
        Ok(())
    }
    fn check_lp(&self, mint: &Mint, lock: &TokenAccount) -> Result<()> {
        require!(self.phase == POOL && self.locked_lp > 0 && lock.amount >= self.locked_lp && mint.supply >= lock.amount, ErrorCode::LpAccounting);
        Ok(())
    }
}

// This switch is compiled into the binary, not read from a website or a config file.
// It cannot be changed by a transaction. Production activation needs a separately
// reviewed program upgrade. The public-v41 feature is a separate review candidate.
#[cfg(all(feature = "local-market-testing", feature = "public-v41"))]
compile_error!("local-market-testing and public-v41 are mutually exclusive");
const LOCAL_MARKET_TESTING: bool = cfg!(feature = "local-market-testing");
const PUBLIC_PILOT: bool = cfg!(feature = "public-v41");
const EXECUTION_ENABLED: bool = LOCAL_MARKET_TESTING || PUBLIC_PILOT;
const PILOT_SUPPLY: u64 = 1_000_000_000_000; // 1,000,000 tokens, six decimals
const PILOT_VIRTUAL_QUOTE: u64 = 100_000_000; // 0.1 wrapped SOL
const PILOT_GRADUATION_QUOTE: u64 = 200_000_000; // 0.2 wrapped SOL

const PILOT_QUOTE_CAP: u64 = 1_000_000_000; // Legacy V33 only.
const V41_VIRTUAL_QUOTE: u64 = 3_500_000_000;
// ceil(sqrt(69 SOL * 3.5 SOL)) - 3.5 SOL, in integer lamports.
const V41_GRADUATION_QUOTE: u64 = 12_040_270_268;
const V41_QUOTE_CAP: u64 = 25_000_000_000; // Proposed bounded exposure for new markets.
fn native_profile_cap(supply: u64, virtual_quote: u64, graduation_quote: u64) -> Result<u64> {
    require!(supply == PILOT_SUPPLY, ErrorCode::PilotProfile);
    match (virtual_quote, graduation_quote) {
        (PILOT_VIRTUAL_QUOTE, PILOT_GRADUATION_QUOTE) => Ok(PILOT_QUOTE_CAP),
        (V41_VIRTUAL_QUOTE, V41_GRADUATION_QUOTE) => Ok(V41_QUOTE_CAP),
        _ => err!(ErrorCode::PilotProfile),
    }
}
const LOCKED: u8 = 0;
const ACTIVE: u8 = 1;
const PAUSED: u8 = 2;

// A native soft pause is an entry stop, not a full security circuit breaker.
// READY must graduate first; graduation is permitted while paused.
// Retain historical generic local-market-testing behavior separately.
fn swap_allowed_while_paused(buy: bool, phase: u8) -> bool {
    !buy && (phase == CURVE || (PUBLIC_PILOT && phase == POOL))
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub schema: u8,
    pub bump: u8,
    pub mode: u8,
    pub admin: Pubkey,
    pub pauser: Pubkey,
    pub pending_admin: Pubkey,
    pub treasury: Pubkey,
}
impl ProtocolConfig {
    fn check_schema(&self) -> Result<()> {
        require!(self.schema == 2, ErrorCode::Schema);
        require!(self.treasury != Pubkey::default() && self.treasury != self.admin && self.treasury != self.pauser, ErrorCode::ProtocolAuthority);
        Ok(())
    }
    fn require_operation(&self, allowed_while_paused: bool) -> Result<()> {
        self.check_schema()?;
        require!(EXECUTION_ENABLED, ErrorCode::ExecutionDisabled);
        match self.mode {
            ACTIVE => Ok(()),
            PAUSED if allowed_while_paused => Ok(()),
            PAUSED => err!(ErrorCode::ProtocolPaused),
            _ => err!(ErrorCode::ProtocolLocked),
        }
    }
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ErrorCode::ProtocolAuthority)]
    pub program: Program<'info, crate::program::GhostMarkets>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ErrorCode::ProtocolAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [b"protocol"], bump)]
    pub protocol: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
    /// Separate fee beneficiary must accept at bootstrap; no treasury secret in the application.
    pub treasury: Signer<'info>,
}

#[derive(Accounts)]
pub struct ManageProtocol<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, ProtocolConfig>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    #[account(init, payer=creator, space=8+Market::INIT_SPACE, seeds=[b"market", creator.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init, payer=creator, seeds=[b"base-mint", market.key().as_ref()], bump, mint::decimals=6, mint::authority=market)]
    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(init, payer=creator, seeds=[b"lp-mint", market.key().as_ref()], bump, mint::decimals=6, mint::authority=market)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(init, payer=creator, seeds=[b"base-vault", market.key().as_ref()], bump, token::mint=base_mint, token::authority=market)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer=creator, seeds=[b"quote-vault", market.key().as_ref()], bump, token::mint=quote_mint, token::authority=market)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer=creator, seeds=[b"lp-lock", market.key().as_ref()], bump, token::mint=lp_mint, token::authority=market)]
    pub lp_lock: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub trader: Signer<'info>,
    #[account(mut, seeds=[b"market", market.creator.as_ref(), &market.nonce.to_le_bytes()], bump=market.bump, has_one=base_mint, has_one=quote_mint, has_one=base_vault, has_one=quote_vault)]
    pub market: Box<Account<'info, Market>>,
    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint=base_mint, token::authority=market)] pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=quote_mint, token::authority=market)] pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=base_mint, token::authority=trader)] pub user_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=quote_mint, token::authority=trader)] pub user_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut, seeds=[b"market", market.creator.as_ref(), &market.nonce.to_le_bytes()], bump=market.bump, has_one=base_mint, has_one=quote_mint, has_one=lp_mint, has_one=base_vault, has_one=quote_vault, has_one=lp_lock)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)] pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, mint::authority=market)] pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint=base_mint, token::authority=market)] pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(token::mint=quote_mint, token::authority=market)] pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=lp_mint, token::authority=market)] pub lp_lock: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
}

#[derive(Accounts)]
pub struct LiquidityChange<'info> {
    pub provider: Signer<'info>,
    #[account(mut, seeds=[b"market", market.creator.as_ref(), &market.nonce.to_le_bytes()], bump=market.bump, has_one=base_mint, has_one=quote_mint, has_one=lp_mint, has_one=base_vault, has_one=quote_vault, has_one=lp_lock)]
    pub market: Box<Account<'info, Market>>,
    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, mint::authority=market)] pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint=base_mint, token::authority=market)] pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=quote_mint, token::authority=market)] pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(token::mint=lp_mint, token::authority=market)] pub lp_lock: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=base_mint, token::authority=provider)] pub user_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=quote_mint, token::authority=provider)] pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=lp_mint, token::authority=provider)] pub user_lp: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, ProtocolConfig>>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub recipient: Signer<'info>,
    #[account(mut, seeds=[b"market", market.creator.as_ref(), &market.nonce.to_le_bytes()], bump=market.bump, has_one=quote_mint, has_one=quote_vault)]
    pub market: Box<Account<'info, Market>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint=quote_mint, token::authority=market)] pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint=quote_mint, token::authority=recipient)] pub destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(seeds=[b"protocol"], bump=protocol.bump)] pub protocol: Box<Account<'info, ProtocolConfig>>,
}
#[event]
pub struct NativeFeeAccrued { pub market:Pubkey, pub quote_mint:Pubkey, pub phase:u8, pub platform_fee:u64, pub creator_fee:u64 }
#[event]
pub struct NativeFeeClaimed { pub market:Pubkey, pub recipient:Pubkey, pub amount:u64, pub is_platform:bool }
#[event]
pub struct ProtocolModeChanged { pub previous: u8, pub next: u8, pub authority: Pubkey }
#[event]
pub struct ProtocolAdminNominated { pub current: Pubkey, pub nominee: Pubkey }
#[event]
pub struct ProtocolAdminChanged { pub previous: Pubkey, pub next: Pubkey }
#[event]
pub struct ProtocolPauserChanged { pub previous: Pubkey, pub next: Pubkey }

#[event]
pub struct MarketCreated { pub market: Pubkey, pub creator: Pubkey, pub base_mint: Pubkey, pub quote_mint: Pubkey, pub initial_supply: u64,
    pub creator_premint: u64, pub virtual_quote: u64, pub graduation_quote: u64, pub fee_bps: u16 }
#[event]
pub struct SwapExecuted { pub market: Pubkey, pub trader: Pubkey, pub buy: bool, pub amount_in: u64, pub amount_out: u64, pub fee: u64,
    pub base_reserve: u64, pub quote_reserve: u64, pub phase: u8, pub version: u64 }
#[event]
pub struct Graduated { pub market: Pubkey, pub burned_unsold_base: u64, pub genesis_locked_lp: u64, pub base_reserve: u64, pub quote_reserve: u64, pub version: u64 }
#[event]
pub struct LiquidityChanged { pub market: Pubkey, pub provider: Pubkey, pub add: bool, pub base_amount: u64, pub quote_amount: u64, pub shares: u64, pub version: u64 }

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid immutable market configuration")] InvalidConfig,
    #[msg("Invalid public metadata")] Metadata,
    #[msg("Quote mint must have no freeze authority")] UnsupportedQuote,
    #[msg("Operation is not available in this market phase")] WrongPhase,
    #[msg("State version changed; obtain a new quote")] StaleVersion,
    #[msg("Transaction deadline slot expired")] Expired,
    #[msg("Integer overflow")] Overflow,
    #[msg("Invalid input amount or pricing result")] InvalidAmount,
    #[msg("Minimum output or shares not met")] Slippage,
    #[msg("Insufficient real reserves or curve floor")] ReserveFloor,
    #[msg("Vault balance is below recorded reserve")] VaultAccounting,
    #[msg("Invalid liquidity or LP accounting")] LpAccounting,
    #[msg("Unsupported account schema")] Schema,
    #[msg("This release binary cannot execute markets")] ExecutionDisabled,
    #[msg("Market execution has not been activated")] ProtocolLocked,
    #[msg("Operation is disabled during emergency pause")] ProtocolPaused,
    #[msg("Signer is not the required protocol authority")] ProtocolAuthority,
    #[msg("Invalid protocol mode transition")] ProtocolTransition,
    #[msg("Public pilot requires the fixed disclosed market profile")] PilotProfile,
    #[msg("Public pilot accounted quote reserve and fee cap exceeded")] PilotCap,
    #[msg("Native launch pool liquidity is entirely locked; external LP issuance/redemption disabled")] LockedLiquidityOnly,
    #[msg("Buy exceeds the remaining curve graduation reserve; obtain a smaller quote")] GraduationOvershoot,
}

#[cfg(test)]
mod protocol_guard_tests {
    use super::*;
    fn config(mode: u8) -> ProtocolConfig {
        ProtocolConfig { schema: 2, bump: 0, mode, admin: Pubkey::new_unique(), pauser: Pubkey::new_unique(), pending_admin: Pubkey::default(), treasury: Pubkey::new_unique() }
    }
    #[test]
    fn profile_caps_and_nominal_graduation() {
        assert_eq!(native_profile_cap(PILOT_SUPPLY, PILOT_VIRTUAL_QUOTE, PILOT_GRADUATION_QUOTE).unwrap(), PILOT_QUOTE_CAP);
        assert_eq!(native_profile_cap(PILOT_SUPPLY, V41_VIRTUAL_QUOTE, V41_GRADUATION_QUOTE).unwrap(), V41_QUOTE_CAP);
        assert!(native_profile_cap(PILOT_SUPPLY, V41_VIRTUAL_QUOTE, PILOT_GRADUATION_QUOTE).is_err());
        let effective = u128::from(V41_VIRTUAL_QUOTE + V41_GRADUATION_QUOTE);
        let target = 69_000_000_000u128 * u128::from(V41_VIRTUAL_QUOTE);
        assert!(effective * effective >= target && (effective - 1) * (effective - 1) < target);
    }
    #[test]
    fn pause_trade_direction_and_phase_are_explicit() {
        for phase in [CURVE, ghost_market_math::READY, POOL, 255] {
            assert!(!swap_allowed_while_paused(true, phase));
        }
        assert!(swap_allowed_while_paused(false, CURVE));
        assert!(!swap_allowed_while_paused(false, ghost_market_math::READY));
        assert_eq!(swap_allowed_while_paused(false, POOL), PUBLIC_PILOT);
        assert!(!swap_allowed_while_paused(false, 255));
    }
    #[test]
    fn locked_and_invalid_modes_refuse_every_operation() {
        for mode in [LOCKED, 255] {
            for allowed in [false, true] {
                assert!(config(mode).require_operation(allowed).is_err());
            }
        }
    }
    #[test]
    fn default_binary_refuses_even_active_config_and_exits() {
        if !EXECUTION_ENABLED {
            for mode in [ACTIVE, PAUSED] {
                for allowed in [false, true] {
                    assert!(config(mode).require_operation(allowed).is_err());
                }
            }
        }
    }
    #[test]
    fn test_variant_allows_only_intended_paused_operations() {
        if EXECUTION_ENABLED {
            assert!(config(ACTIVE).require_operation(false).is_ok());
            assert!(config(ACTIVE).require_operation(true).is_ok());
            assert!(config(PAUSED).require_operation(false).is_err());
            assert!(config(PAUSED).require_operation(true).is_ok());
        }
        let mut invalid = config(ACTIVE);
        invalid.schema = 1;
        assert!(invalid.require_operation(true).is_err());
        let mut invalid = config(ACTIVE);
        invalid.treasury = invalid.admin;
        assert!(invalid.require_operation(true).is_err());
        let mut invalid = config(ACTIVE);
        invalid.treasury = invalid.pauser;
        assert!(invalid.require_operation(true).is_err());
    }
}
