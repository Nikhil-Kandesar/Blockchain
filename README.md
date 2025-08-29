# ABC Staking Protocol

A decentralized staking protocol built on Solana that allows users to stake ABC tokens and earn rewards based on time-based APY calculations.

## 🚀 Features

- **Time-based Rewards**: Earn rewards based on staking duration and APY
- **Lockup Periods**: Configurable lockup periods for different pool types
- **Fixed-point Arithmetic**: Precise reward calculations using 64.64 fixed-point math
- **Multiple Pools**: Support for different staking pools with varying APY and lockup periods
- **Automatic Reward Updates**: Real-time reward accumulation and claiming

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [Yarn](https://yarnpkg.com/) package manager
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (v1.17 or higher)
- [Anchor Framework](https://www.anchor-lang.com/docs/installation) (v0.31.1)
- [Rust](https://rustup.rs/) (latest stable)

## 🛠️ Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd abc_staking
   ```

2. **Install dependencies**
   ```bash
   yarn install
   ```

3. **Build the program**
   ```bash
   anchor build
   ```

4. **Update program ID** (if needed)
   After building, update the program ID in `programs/abc_staking/src/lib.rs`:
   ```rust
   declare_id!("YOUR_GENERATED_PROGRAM_ID");
   ```

## 🏗️ Project Structure

```
abc_staking/
├── programs/
│   └── abc_staking/          # Main staking program
│       ├── src/
│       │   └── lib.rs        # Program logic
│       └── Cargo.toml        # Rust dependencies
├── scripts/                  # Deployment and setup scripts
│   ├── 01_create_mint.ts     # Create ABC token mint
│   ├── 02_init_pools.ts      # Initialize staking pools
│   └── 03_demo_flow.ts       # Demo staking flow
├── tests/                    # Program tests
├── app/                      # Frontend application (if any)
├── Anchor.toml              # Anchor configuration
└── package.json             # Node.js dependencies
```

## 🎯 Core Functions

### Program Instructions

1. **`initialize_pool`** - Create a new staking pool
   - Sets APY (in basis points)
   - Configures lockup period
   - Initializes reward rate calculations

2. **`stake`** - Stake ABC tokens
   - Transfers tokens to pool vault
   - Updates user staking state
   - Calculates pending rewards

3. **`unstake`** - Unstake tokens (after lockup period)
   - Validates lockup period
   - Returns tokens to user
   - Updates pool state

4. **`claim`** - Claim accumulated rewards
   - Calculates earned rewards
   - Transfers rewards to user
   - Resets reward counters

## 📊 Data Structures

### Pool Account
```rust
pub struct Pool {
    pub admin: Pubkey,                    // Pool administrator
    pub mint: Pubkey,                     // ABC token mint
    pub vault: Pubkey,                    // Token vault
    pub bump: u8,                         // PDA bump
    pub apy_bps: u16,                     // APY in basis points
    pub lockup_seconds: u32,              // Lockup period
    pub acc_reward_per_token_fp: u128,    // Accumulated rewards per token
    pub last_update_ts: i64,              // Last update timestamp
    pub reward_rate_fp: u128,             // Reward rate (fixed-point)
    pub total_staked: u64,                // Total staked amount
}
```

### User Stake Account
```rust
pub struct UserStake {
    pub owner: Pubkey,                    // User public key
    pub pool: Pubkey,                     // Pool public key
    pub amount_staked: u64,               // Staked amount
    pub rewards_owed_fp: u128,            // Pending rewards
    pub user_entry_acc_rpt_fp: u128,     // Entry point for rewards
    pub stake_ts: i64,                    // Stake timestamp
}
```

## 🚀 Quick Start

### 1. Setup Local Environment

```bash
# Start local validator
solana-test-validator

# In another terminal, set cluster to localnet
solana config set --url localhost

# Airdrop SOL for testing
solana airdrop 2
```

### 2. Deploy and Setup

```bash
# Build and deploy
anchor build
anchor deploy

# Create ABC token mint
yarn ts-node scripts/01_create_mint.ts

# Initialize staking pools
yarn ts-node scripts/02_init_pools.ts
```

### 3. Run Demo

```bash
# Execute demo staking flow
yarn ts-node scripts/03_demo_flow.ts
```

## 🧪 Testing

Run the test suite:

```bash
anchor test
```

Or run specific tests:

```bash
anchor test --skip-local-validator
```

## 📝 Scripts

### `01_create_mint.ts`
- Creates ABC token mint with 9 decimals
- Mints 1,000,000 ABC tokens to user
- Saves configuration to `keys.json`

### `02_init_pools.ts`
- Initializes staking pools with different APY and lockup periods
- Creates pool vaults and associated token accounts

### `03_demo_flow.ts`
- Demonstrates complete staking flow
- Shows staking, claiming rewards, and unstaking

## 🔧 Configuration

### Anchor.toml
```toml
[programs.localnet]
abc_staking = "YOUR_PROGRAM_ID"

[provider]
cluster = "localnet"
wallet = "~/.config/solana/id.json"
```

### Environment Variables
- `ANCHOR_PROVIDER_URL`: Solana cluster URL
- `ANCHOR_WALLET`: Path to wallet keypair

## 🎨 Reward Calculation

The protocol uses fixed-point arithmetic for precise reward calculations:

- **APY to Rate Conversion**: `rate = APY / seconds_per_year`
- **Reward Accumulation**: `rewards = staked_amount * rate * time`
- **Fixed-point Precision**: 64.64 bit representation for accuracy

## 🔒 Security Features

- **Overflow Protection**: All mathematical operations use checked arithmetic
- **Lockup Enforcement**: Tokens cannot be unstaked before lockup period
- **PDA Validation**: All accounts use Program Derived Addresses
- **Authority Checks**: Proper authority validation for all operations

## 🐛 Troubleshooting

### Common Issues

1. **Build Errors**
   ```bash
   # Clean and rebuild
   anchor clean
   anchor build
   ```

2. **Deployment Issues**
   ```bash
   # Check Solana config
   solana config get
   
   # Ensure sufficient SOL
   solana balance
   ```

3. **Script Errors**
   ```bash
   # Check keys.json exists
   ls keys.json
   
   # Verify program deployment
   anchor deploy --provider.cluster localnet
   ```

## 📄 License

This project is licensed under the ISC License.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## 📞 Support

For questions and support:
- Open an issue on GitHub
- Check the [Anchor documentation](https://www.anchor-lang.com/docs)
- Review [Solana documentation](https://docs.solana.com/)

## 🔄 Version History

- **v0.1.0**: Initial release with basic staking functionality
  - Core staking operations
  - Reward calculation system
  - Lockup period enforcement
  - Fixed-point arithmetic implementation
  - Fixed TypeScript compilation issues
  - Resolved build warnings and duplicates
