use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("AbcStaK1ng111111111111111111111111111111111"); // replace during deploy

// Constants
const SECONDS_PER_YEAR: i64 = 31_536_000; // 365d
const FP_SHIFT: u32 = 64;
const FP_ONE: u128 = 1u128 << FP_SHIFT;

#[program]
pub mod abc_staking {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        apy_bps: u16,
        lockup_seconds: u32,
    ) -> Result<()> {
        require!(apy_bps <= 10_000, ErrorCode::InvalidParams); // cap at 100% APY
        let pool = &mut ctx.accounts.pool;

        pool.admin = ctx.accounts.admin.key();
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.vault_ata.key();
        pool.bump = *ctx.bumps.get("pool").unwrap();
        pool.apy_bps = apy_bps;
        pool.lockup_seconds = lockup_seconds;

        pool.acc_reward_per_token_fp = 0;
        pool.rewards_owed_global_fp = 0; // not used externally; optional
        pool.total_staked = 0;
        pool.last_update_ts = now_ts(pool)?;
        pool.time_offset = 0;

        // Linear per-second rate: r_ps = (APY/10000) / SECONDS_PER_YEAR in Q64.64
        let apy_num = apy_bps as u128;
        let r_ps_fp = (apy_num * FP_ONE) / 10_000u128 / (SECONDS_PER_YEAR as u128);
        pool.reward_rate_fp = r_ps_fp;

        // Sanity: vault ATA must match PDA owner and mint
        require_keys_eq!(ctx.accounts.vault_ata.mint, ctx.accounts.mint.key(), ErrorCode::InvalidVault);
        require_keys_eq!(ctx.accounts.vault_ata.owner, ctx.accounts.pool_signer.key(), ErrorCode::InvalidVault);

        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);

        // Pool-level update
        update_pool_rewards(&mut ctx.accounts.pool)?;

        // User-level update
        update_user_rewards(&mut ctx.accounts.user_stake, &ctx.accounts.pool)?;

        // Transfer tokens from user to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update staking amounts
        let user = &mut ctx.accounts.user_stake;
        let pool = &mut ctx.accounts.pool;

        if user.amount_staked == 0 {
            user.stake_ts = now_ts(pool)?;
        }
        user.amount_staked = user.amount_staked.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        pool.total_staked = pool.total_staked.checked_add(amount).ok_or(ErrorCode::Overflow)?;

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        // Pool-level update
        update_pool_rewards(&mut ctx.accounts.pool)?;

        // User-level update (to add pending to rewards_owed_fp)
        update_user_rewards(&mut ctx.accounts.user_stake, &ctx.accounts.pool)?;

        // Convert fixed-point owed to integer tokens
        let owed_fp = ctx.accounts.user_stake.rewards_owed_fp;
        let tokens_owed: u64 = (owed_fp / FP_ONE) as u64;

        if tokens_owed > 0 {
            // Reduce the owed_fp by the paid integer portion, keep fractional remainder
            let paid_back_fp = (tokens_owed as u128) * FP_ONE;
            ctx.accounts.user_stake.rewards_owed_fp = owed_fp - paid_back_fp;

            // Transfer from vault to user
            let pool = &ctx.accounts.pool;
            let seeds: &[&[u8]] = &[
                b"pool",
                pool.mint.as_ref(),
                pool.admin.as_ref(),
                &[pool.bump],
            ];
            let signer_seeds: &[&[&[u8]]] = &[seeds];

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_ata.to_account_info(),
                to: ctx.accounts.user_ata.to_account_info(),
                authority: ctx.accounts.pool_signer.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, tokens_owed)?;
        }

        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);

        // Enforce lockup for Pool B-like configs
        let pool = &ctx.accounts.pool;
        let now = now_ts(pool)?;
        if pool.lockup_seconds > 0 {
            let st_ts = ctx.accounts.user_stake.stake_ts;
            require!(now.saturating_sub(st_ts) >= pool.lockup_seconds as i64, ErrorCode::Lockup);
        }

        // Pool-level update
        update_pool_rewards(&mut ctx.accounts.pool)?;

        // User-level update
        update_user_rewards(&mut ctx.accounts.user_stake, &ctx.accounts.pool)?;

        // Update staking amounts
        let user = &mut ctx.accounts.user_stake;
        require!(user.amount_staked >= amount, ErrorCode::InsufficientStake);
        user.amount_staked = user.amount_staked - amount;

        let pool = &mut ctx.accounts.pool;
        pool.total_staked = pool.total_staked - amount;

        // Transfer tokens from vault to user
        let seeds: &[&[u8]] = &[
            b"pool",
            pool.mint.as_ref(),
            pool.admin.as_ref(),
            &[pool.bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.user_ata.to_account_info(),
            authority: ctx.accounts.pool_signer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    // Optional admin-only update
    pub fn set_params(ctx: Context<SetParams>, apy_bps: u16, lockup_seconds: u32) -> Result<()> {
        require_keys_eq!(ctx.accounts.pool.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(apy_bps <= 10_000, ErrorCode::InvalidParams);

        // Always update rewards first to keep determinism
        update_pool_rewards(&mut ctx.accounts.pool)?;

        let pool = &mut ctx.accounts.pool;
        pool.apy_bps = apy_bps;
        pool.lockup_seconds = lockup_seconds;

        let apy_num = apy_bps as u128;
        pool.reward_rate_fp = (apy_num * FP_ONE) / 10_000u128 / (SECONDS_PER_YEAR as u128);

        Ok(())
    }

    // Test-only helper: time warp by setting an offset used in now_ts()
    pub fn set_time_offset(ctx: Context<AdminOnly>, offset_seconds: i64) -> Result<()> {
        require_keys_eq!(ctx.accounts.pool.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        ctx.accounts.pool.time_offset = offset_seconds;
        Ok(())
    }
}

// Helpers

fn now_ts(pool: &Pool) -> Result<i64> {
    let clock = Clock::get()?;
    Ok(clock.unix_timestamp.saturating_add(pool.time_offset))
}

fn update_pool_rewards(pool: &mut Account<Pool>) -> Result<()> {
    let now = now_ts(pool)?;
    let dt = now.saturating_sub(pool.last_update_ts);
    if dt <= 0 {
        return Ok(());
    }
    if pool.total_staked == 0 {
        pool.last_update_ts = now;
        return Ok(());
    }
    // reward_added_fp = dt * reward_rate_fp * total_staked
    let dt_u = dt as u128;
    let added_fp = dt_u
        .checked_mul(pool.reward_rate_fp).ok_or(ErrorCode::Overflow)?
        .checked_mul(pool.total_staked as u128).ok_or(ErrorCode::Overflow)?;
    // acc_rpt += added_fp / total_staked
    let incr = added_fp / (pool.total_staked as u128);
    pool.acc_reward_per_token_fp = pool.acc_reward_per_token_fp.checked_add(incr).ok_or(ErrorCode::Overflow)?;
    pool.last_update_ts = now;
    Ok(())
}

fn update_user_rewards(user: &mut Account<UserStake>, pool: &Account<Pool>) -> Result<()> {
    let delta = pool.acc_reward_per_token_fp
        .checked_sub(user.user_entry_acc_rpt_fp)
        .ok_or(ErrorCode::Underflow)?;
    let pending = (user.amount_staked as u128)
        .checked_mul(delta)
        .ok_or(ErrorCode::Overflow)?;
    user.rewards_owed_fp = user.rewards_owed_fp.checked_add(pending).ok_or(ErrorCode::Overflow)?;
    user.user_entry_acc_rpt_fp = pool.acc_reward_per_token_fp;
    Ok(())
}

// Accounts

#[derive(Accounts)]
#[instruction(apy_bps: u16, lockup_seconds: u32)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Pool::SIZE,
        seeds = [b"pool", mint.key().as_ref(), admin.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    /// CHECK: signer PDA for the pool, used as vault authority
    #[account(
        seeds = [b"pool", mint.key().as_ref(), admin.key().as_ref()],
        bump
    )]
    pub pool_signer: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = vault_ata.mint == mint.key(),
        constraint = vault_ata.owner == pool_signer.key()
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStake::SIZE,
        seeds = [b"user_stake", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    /// CHECK: signer PDA for the pool
    #[account(
        seeds = [b"pool", pool.mint.as_ref(), pool.admin.as_ref()],
        bump = pool.bump
    )]
    pub pool_signer: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault_ata.mint == pool.mint,
        constraint = vault_ata.owner == pool_signer.key()
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user_stake", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    /// CHECK: signer PDA for the pool
    #[account(
        seeds = [b"pool", pool.mint.as_ref(), pool.admin.as_ref()],
        bump = pool.bump
    )]
    pub pool_signer: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault_ata.mint == pool.mint,
        constraint = vault_ata.owner == pool_signer.key()
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user_stake", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    /// CHECK: signer PDA for the pool
    #[account(
        seeds = [b"pool", pool.mint.as_ref(), pool.admin.as_ref()],
        bump = pool.bump
    )]
    pub pool_signer: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault_ata.mint == pool.mint,
        constraint = vault_ata.owner == pool_signer.key()
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

// State

#[account]
pub struct Pool {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,

    pub apy_bps: u16,
    pub lockup_seconds: u32,

    pub acc_reward_per_token_fp: u128,
    pub rewards_owed_global_fp: u128, // reserved/optional
    pub last_update_ts: i64,
    pub reward_rate_fp: u128,
    pub total_staked: u64,

    pub time_offset: i64, // test helper for deterministic warp
}

impl Pool {
    pub const SIZE: usize = 32 + 32 + 32 + 1
        + 2 + 4
        + 16 + 16 + 8 + 16 + 8
        + 8;
}

#[account]
pub struct UserStake {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount_staked: u64,
    pub rewards_owed_fp: u128,
    pub user_entry_acc_rpt_fp: u128,
    pub stake_ts: i64,
}

impl UserStake {
    pub const SIZE: usize = 32 + 32 + 8 + 16 + 16 + 8;
}

// Errors

#[error_code]
pub enum ErrorCode {
    #[msg("Zero amount not allowed")]
    ZeroAmount,
    #[msg("Lockup not satisfied")]
    Lockup,
    #[msg("Invalid vault account")]
    InvalidVault,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid params")]
    InvalidParams,
    #[msg("Overflow")]
    Overflow,
    #[msg("Underflow")]
    Underflow,
    #[msg("Insufficient staked amount")]
    InsufficientStake,
}
