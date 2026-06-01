use anchor_lang::prelude::*;

#[error_code]
pub enum MarketplaceError {
    #[msg("Fee must be expressed in basis points (0 to 10000)")]
    InvalidFee,
    #[msg("Marketplace name must be 32 characters or fewer")]
    NameTooLong,
    #[msg("Maker cannot buy their own listing")]
    SelfBuyNotAllowed,
    #[msg("Withdraw amount must be greater than zero")]
    InvalidWithdrawAmount,
}