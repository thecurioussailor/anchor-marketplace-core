use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};

use crate::{
    state::{
        Marketplace
    },
    errors::MarketplaceError
};

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"marketplace", marketplace.name.as_str().as_bytes()],
        bump = marketplace.bump,
        has_one = admin,
    )]
    pub marketplace: Account<'info, Marketplace>,

    #[account(
        mut,
        seeds = [b"treasury", marketplace.key().as_ref()],
        bump = marketplace.treasury_bump,
    )]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> WithdrawFees<'info> {
    pub fn withdraw_fees(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, MarketplaceError::InvalidWithdrawAmount);

        let mp_key = self.marketplace.key();
        let seeds: &[&[u8]] = &[
            b"treasury",
            mp_key.as_ref(),
            &[self.marketplace.treasury_bump],
        ];
        let signer_seeds = &[seeds];

        transfer(
            CpiContext::new_with_signer(
                self.system_program.to_account_info(),
                Transfer {
                    from: self.treasury.to_account_info(),
                    to: self.admin.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        Ok(())
    }
}