//! GHOST Markets: public SPL-token market research candidate. No private rail.
//! Uncompiled at preparation time; local-validator conformance is mandatory.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, spl_token::instruction::AuthorityType, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount, TransferChecked};
use ghost_market_math::{MarketState, MarketError, POOL};

// Source placeholder; replace with a fresh local/development deployment key via anchor keys sync.
declare_id!("FQ9qkZv3nBnDubM5oznc4kF2LzzTA7i5xsmBkC6hAWbg");

#[program]
pub mod ghost_markets {
    use super::*;

    pub fn create_market(ctx: Context<CreateMarket>, nonce: u64, args: CreateArgs) -> Result<()> {
        require!(!args.name.is_empty() && args.name.len() <= 32 && !args.name.chars().any(char::is_control), ErrorCode::Metadata);
        require!(!args.symbol.is_empty() && args.symbol.len() <= 10 && args.symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()), ErrorCode::Metadata);
        require!(args.metadata_uri.len() <= 200 && !args.metadata_uri.chars().any(char::is_control), ErrorCode::Metadata);
        // Original SPL Token only. A quote mint with freeze authority could stop exits.
        require!(ctx.accounts.quote_mint.freeze_authority.is_none(), ErrorCode::UnsupportedQuote);
        let state = math(MarketState::new(args.supply, args.virtual_quote, args.graduation_quote, args.fee_bps))?;
        let a = ctx.accounts;
        let m = &mut a.market;
        m.schema = 1;
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
        let a = ctx.accounts;
        let m = &mut a.market;
        let s = m.checked_state(&a.base_vault, &a.quote_vault, expected_version, deadline_slot)?;
        let q = math(s.swap(buy, amount_in, minimum_out))?;
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
        m.apply(q.next);
        emit!(SwapExecuted { market: m.key(), trader: a.trader.key(), buy, amount_in, amount_out: q.amount_out, fee: q.fee,
            base_reserve: m.base_reserve, quote_reserve: m.quote_reserve, phase: m.phase, version: m.version });
        Ok(())
    }

    pub fn graduate(ctx: Context<Graduate>, expected_version: u64, deadline_slot: u64) -> Result<()> {
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
        require!(self.schema == 1, ErrorCode::Schema);
        // Unsolicited donations never alter quoted reserves or grant a withdrawal right.
        require!(base.amount >= self.base_reserve && quote.amount >= self.quote_reserve, ErrorCode::VaultAccounting);
        let s = self.state(); math(s.guard(expected_version, deadline_slot, Clock::get()?.slot))?; Ok(s)
    }
    fn check_lp(&self, mint: &Mint, lock: &TokenAccount) -> Result<()> {
        require!(self.phase == POOL && self.locked_lp > 0 && lock.amount >= self.locked_lp && mint.supply >= lock.amount, ErrorCode::LpAccounting);
        Ok(())
    }
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
}

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
}
