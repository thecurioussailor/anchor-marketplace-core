# anchor-marketplace-core

An Anchor program on Solana implementing a trustless NFT marketplace for **MPL Core** assets. Sellers list their assets on-chain, buyers purchase them with SOL, and a configurable fee is routed to a treasury. Buyers receive a fungible reward token on every purchase.

Program ID: `3xhZuCq1ddQwWayATgBE1QFqjJ1BUyyXH4j73FJzbBgV`

## Test Results

![7 passing tests](test.png)

## Features

- **Initialize** — deploy a named marketplace instance with a fee in basis points (0–10 000) and a PDA-controlled reward mint
- **List** — transfer an MPL Core asset into a listing PDA and record the asking price
- **Buy** — atomically pay the maker, route the fee to the treasury, transfer the asset to the buyer, and mint one reward token to the buyer
- **Delist** — return the asset to the maker and close the listing account (rent reclaimed)
- **Withdraw Fees** — allow the admin to pull accumulated SOL from the treasury

## Architecture

### Accounts

| Account | Seeds | Description |
|---------|-------|-------------|
| `Marketplace` | `["marketplace", name]` | Stores admin, fee (bps), and bump cache |
| `Treasury` | `["treasury", marketplace]` | Holds fee lamports; a bare `SystemAccount` |
| `RewardMint` | `["rewards", marketplace]` | SPL token mint; authority is the marketplace PDA |
| `Listing` | `["listing", asset]` | Records maker, asset address, price, and bump |

### Instruction Flow

```
initialize(name, fee)
  └─ creates Marketplace + Treasury PDA + RewardMint

list(price)
  └─ creates Listing PDA
  └─ MPL Core TransferV1: maker → listing PDA

buy()
  ├─ SOL: taker → maker  (price − fee)
  ├─ SOL: taker → treasury  (fee)
  ├─ MPL Core TransferV1: listing PDA → taker  (PDA signs)
  ├─ close Listing → maker  (rent returned)
  └─ mint 1 reward token → taker ATA

delist()
  ├─ MPL Core TransferV1: listing PDA → maker  (PDA signs)
  └─ close Listing → maker  (rent returned)

withdraw_fees(amount)
  └─ SOL: treasury PDA → admin  (treasury PDA signs)
```

### Fee Calculation

```
fee_lamports = price × fee_bps / 10_000
maker_receives = price − fee_lamports
```

## Security Properties

- **No self-buy** — `buy` enforces `taker ≠ maker` via `require_keys_neq!`
- **Admin-only withdrawals** — `withdraw_fees` uses `has_one = admin` on the marketplace account
- **Zero-amount guard** — withdrawal of 0 lamports is rejected
- **Overflow-safe fee math** — intermediate product is widened to `u128` before division
- **Asset custody via PDAs** — the listing PDA becomes the mpl-core asset owner; it signs transfers using `invoke_signed`

## Prerequisites

| Tool | Version |
|------|---------|
| Rust / Cargo | stable (see `rust-toolchain.toml`) |
| Solana CLI | 1.18+ |
| Anchor CLI | 0.32.x |
| Node.js | 18+ |
| Yarn | 1.x |

## Getting Started

```bash
# Install JS dependencies
yarn install

# Build the program
anchor build

# Run all tests against a local validator
anchor test
```

The test validator automatically clones the MPL Core program from mainnet (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`) so no manual setup is needed.

## Tests

All 7 tests pass:

| Test | What it verifies |
|------|-----------------|
| initializes the marketplace | Marketplace account fields, reward mint decimals and authority |
| lists an mpl-core asset | Listing account fields, asset owner becomes the listing PDA |
| lets a taker buy the listed asset | Asset owner becomes taker, listing closes, maker receives price minus fee, treasury receives fee, taker receives 1 reward token |
| rejects a self-buy | `SelfBuyNotAllowed` error returned when taker == maker |
| lets the maker delist an asset | Asset returns to maker, listing closes |
| lets admin withdraw treasury fees | Treasury balance decreases, admin balance increases by exact amount |
| rejects unauthorized and zero-amount withdrawals | `ConstraintHasOne` for non-admin, `InvalidWithdrawAmount` for zero |

## Project Structure

```
programs/anchor-marketplace-core/src/
├── lib.rs                    # Program entrypoint and instruction dispatchers
├── state.rs                  # Marketplace and Listing account structs
├── errors.rs                 # Custom error codes
└── instructions/
    ├── initialize.rs
    ├── list.rs
    ├── buy.rs
    ├── delist.rs
    └── withdraw_fees.rs
tests/
└── anchor-marketplace-core.ts   # Full integration test suite
```

## Dependencies

- [anchor-lang](https://crates.io/crates/anchor-lang) `0.32.1`
- [anchor-spl](https://crates.io/crates/anchor-spl) `0.32.1`
- [mpl-core](https://crates.io/crates/mpl-core) `0.11.2` (with `anchor` feature)
