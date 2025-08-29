import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { AbcStaking } from "../target/types/abc_staking";
import * as fs from "fs";

const STAKE_AMOUNT = 10; // 10 ABC

// Helper to warp time on the local validator
async function warpSeconds(provider: anchor.AnchorProvider, seconds: number) {
  const rpcResponse = await fetch(provider.connection.rpcEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "warp_clock_by_seconds",
      params: [seconds],
    }),
  });
  const json: any = await rpcResponse.json();
  if (json && json.error) {
    throw new Error(json.error);
  }
  console.log(`\n⏰ Warped time forward by ${seconds} seconds.`);

async function logBalances(
  provider: anchor.AnchorProvider,
  poolPda: PublicKey,
  userAta: PublicKey
) {
  const poolState = await provider.connection.getAccountInfo(poolPda);
  if (!poolState) {
    console.log("Pool not found");
    return;
  }
  const poolVaultAddress = new PublicKey(poolState.data.slice(40, 72));
  
  const userBalance = (await provider.connection.getTokenAccountBalance(userAta)).value.uiAmountString;
  const vaultBalance = (await provider.connection.getTokenAccountBalance(poolVaultAddress)).value.uiAmountString;

  console.log(`- User ATA Balance: ${userBalance} ABC`);
  console.log(`- Pool Vault Balance: ${vaultBalance} ABC`);
}

async function main() {
  // --- Setup ---
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AbcStaking as anchor.Program<AbcStaking>;
  const wallet = provider.wallet as anchor.Wallet;

  // --- Load Config ---
  const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
  const mint = new PublicKey(config.mint);
  const userAta = new PublicKey(config.userAta);

  // --- Derive Pool PDA ---
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint.toBuffer()],
    program.programId
  );

  const stakeAmountUi = new anchor.BN(STAKE_AMOUNT * 10 ** 9);

  console.log("\n--- Starting Demo Flow ---");
  console.log("Initial Balances:");
  await logBalances(provider, poolPda, userAta);

  // --- Stake ---
  console.log(`\nStaking ${STAKE_AMOUNT} ABC...`);
  await program.methods
    .stake(stakeAmountUi)
    .accounts({
      user: wallet.publicKey,
      // userAta is not a valid account for this instruction, so we remove it
    })
    .rpc();
    console.log("✅ Stake successful.");
  console.log("Balances after stake:");
  await logBalances(provider, poolPda, userAta);

  // --- Warp Time ---
  const thirtyDaysInSeconds = 30 * 24 * 60 * 60;
  await warpSeconds(provider, thirtyDaysInSeconds);
  
  // --- Claim Rewards ---
  // To claim, the reward vault must be funded. For this demo, we assume it was funded
  // by the authority. The test suite handles funding explicitly.
  console.log("\nClaiming rewards...");
  try {
    const poolState = await program.account.pool.fetch(poolPda);
    await program.methods
      .claim()
      .accounts({
        user: wallet.publicKey,
      })
      .rpc();
    console.log("✅ Claim successful.");
  } catch (err) {
    console.error("⚠️  Claim failed. This is expected if the reward vault is empty.", err.message);
    console.log("The test suite ('anchor test') properly funds the reward vault for successful claims.");
  }
  
  console.log("Balances after claim attempt:");
  await logBalances(provider, poolPda, userAta);
  
  // --- Unstake ---
  console.log(`\nUnstaking ${STAKE_AMOUNT} ABC...`);
  await program.methods
    .unstake(stakeAmountUi)
    .accounts({
      user: wallet.publicKey,
    })
    .rpc();
  console.log("✅ Unstake successful.");

  console.log("\nFinal Balances:");
  await logBalances(provider, poolPda, userAta);
  console.log("\n--- Demo Flow Complete ---");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
})
}
