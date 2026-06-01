use anchor_lang::prelude::*;

pub mod state;
pub mod instructions;
pub mod errors;

pub use state::*;
pub use instructions::*;
declare_id!("3xhZuCq1ddQwWayATgBE1QFqjJ1BUyyXH4j73FJzbBgV");

#[program]
pub mod anchor_marketplace_core {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, name: String, fee: u16) -> Result<()> {
        ctx.accounts.init(name, fee, &ctx.bumps)
    }

    
}
