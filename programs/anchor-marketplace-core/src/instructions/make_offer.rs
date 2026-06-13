use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};

use crate::state::Offer;

#[derive(Accounts)]
pub struct MakeOffer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: only used to derive the offer PDA
    pub asset: UncheckedAccount<'info>,

    #[account(
        init,
        payer = buyer,
        seeds = [b"offer", asset.key().as_ref(), buyer.key().as_ref()],
        bump,
        space = 8 + Offer::INIT_SPACE,
    )]
    pub offer: Account<'info, Offer>,

    pub system_program: Program<'info, System>,
}

impl<'info> MakeOffer<'info> {
    pub fn make_offer(&mut self, amount: u64, bumps: &MakeOfferBumps) -> Result<()> {
        self.offer.set_inner(Offer {
            buyer: self.buyer.key(),
            asset: self.asset.key(),
            amount,
            bump: bumps.offer,
        });

        transfer(
            CpiContext::new(
                self.system_program.to_account_info(),
                Transfer {
                    from: self.buyer.to_account_info(),
                    to: self.offer.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }
}
