import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { BN } from "bn.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

const DECIMALS = 9;
const ONE = BigInt("1000000000");
const SECONDS_PER_YEAR = 31_536_000;

function toBase(n: number): bigint {
  return BigInt(Math.floor(n * Math.pow(10, DECIMALS)));
}

function fromBase(x: bigint): number {
  return Number(x) / 1e9;
}
function rewardLinear(apy_bps: number, principal: number, seconds: number): number {
  const apy = apy_bps / 10_000;
  return principal * (apy * (seconds / SECONDS_PER_YEAR));
}

describe("abc_staking", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AbcStaking as anchor.Program;

  let mint: PublicKey;
  let user = (provider.wallet as anchor.Wallet).payer;
  let userAta: PublicKey;

  let poolA: PublicKey;
  let poolASigner: PublicKey;
  let vaultA: PublicKey;
  let userStakeA: PublicKey;

  let poolB: PublicKey;
  let poolBSigner: PublicKey;
  let vaultB: PublicKey;
  let userStakeB: PublicKey;

  it("A) Setup & Initialization", async () => {
    // Create ABC mint 9 decimals and user ATA, mint 1,000 ABC
    mint = await createMint(provider.connection, user, user.publicKey, null, 9);
    const userAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      mint,
      user.publicKey
    );
    userAta = userAtaAcc.address;

    const amt = BigInt(1_000) * ONE;
    await mintTo(provider.connection, user, mint, userAta, user, Number(amt));

    // Derive pool PDA and vaults
    [poolA] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mint.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );
    poolASigner = poolA;
    [poolB] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mint.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );
    poolBSigner = poolB;

    const vaultAAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      mint,
      poolASigner,
      true
    );
    vaultA = vaultAAcc.address;

    const vaultBAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      mint,
      poolBSigner,
      true
    );
    vaultB = vaultBAcc.address;

    // Init pools
    await program.methods
      .initializePool(1000, 0)
      .accounts({
        admin: user.publicKey,
        pool: poolA,
        poolSigner: poolASigner,
        mint,
        vaultAta: vaultA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    await program.methods
      .initializePool(2000, 30 * 24 * 3600)
      .accounts({
        admin: user.publicKey,
        pool: poolB,
        poolSigner: poolBSigner,
        mint,
        vaultAta: vaultB,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    // Basic asserts: PDAs exist
    // NOTE: The correct way to fetch pool accounts depends on your IDL and Anchor codegen.
    // If 'pool' is not a valid account namespace, you may need to use the correct account name.
    // For example, if your account is named 'stakingPool' in your IDL:
    // const poolAAcc = await program.account.stakingPool.fetch(poolA);
    // const poolBAcc = await program.account.stakingPool.fetch(poolB);

    // For now, try to fetch by the first account in your IDL, or adjust as needed:
    const poolAAcc = await program.account[Object.keys(program.account)[0]].fetch(poolA);
    const poolBAcc = await program.account[Object.keys(program.account)[0]].fetch(poolB);

    expect(poolAAcc.mint.toBase58()).to.eq(mint.toBase58());
    expect(poolAAcc.vault.toBase58()).to.eq(vaultA.toBase58());
    expect(poolBAcc.lockupSeconds).to.eq(30 * 24 * 3600);
  });

  it("B) Stake/Accrue/Claim (10% APY)", async () => {
    [userStakeA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), poolA.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .stake(new BN(toBase(10)))
      .accounts({
        user: user.publicKey,
        userStake: userStakeA,
        userAta,
        pool: poolA,
        poolSigner: poolASigner,
        vaultAta: vaultA,
        mint,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    // Warp time by 30 days
    await program.methods
      .setTimeOffset(new BN(30 * 24 * 3600))
      .accounts({ admin: user.publicKey, pool: poolA })
      .rpc();

    // Claim
    const before = (await provider.connection.getTokenAccountBalance(userAta)).value.uiAmount!;
    await program.methods
      .claim()
      .accounts({
        user: user.publicKey,
        userStake: userStakeA,
        userAta,
        pool: poolA,
        poolSigner: poolASigner,
        vaultAta: vaultA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
    const after = (await provider.connection.getTokenAccountBalance(userAta)).value.uiAmount!;
    const claimed = after - before;

    const expected = rewardLinear(1000, 10, 30 * 24 * 3600);
    expect(Math.abs(claimed - expected)).to.be.lessThan(0.0001);
  });

  it("C) Stake/Accrue/Claim/Unstake (20% APY, lockup)", async () => {
    [userStakeB] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), poolB.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .stake(new BN(toBase(10)))
      .accounts({
        user: user.publicKey,
        userStake: userStakeB,
        userAta,
        pool: poolB,
        poolSigner: poolBSigner,
        vaultAta: vaultB,
        mint,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    // Try unstake before 30d -> should fail
    let failed = false;
    try {
      await program.methods
        .unstake(new BN(toBase(10)))
        .accounts({
          user: user.publicKey,
          userStake: userStakeB,
          userAta,
          pool: poolB,
          poolSigner: poolBSigner,
          vaultAta: vaultB,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        })
        .rpc();
    } catch (e) {
      failed = true;
    }
    expect(failed).to.eq(true);

    // Warp 30d
    await program.methods
      .setTimeOffset(new BN(30 * 24 * 3600))
      .accounts({ admin: user.publicKey, pool: poolB })
      .rpc();

    // Claim then Unstake
    const before = (await provider.connection.getTokenAccountBalance(userAta)).value.uiAmount!;
    await program.methods
      .claim()
      .accounts({
        user: user.publicKey,
        userStake: userStakeB,
        userAta,
        pool: poolB,
        poolSigner: poolBSigner,
        vaultAta: vaultB,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
    const afterClaim = (await provider.connection.getTokenAccountBalance(userAta)).value.uiAmount!;
    const claimed = afterClaim - before;
    const expected = rewardLinear(2000, 10, 30 * 24 * 3600);
    expect(Math.abs(claimed - expected)).to.be.lessThan(0.0001);

    await program.methods
      .unstake(new BN(toBase(10)))
      .accounts({
        user: user.publicKey,
        userStake: userStakeB,
        userAta,
        pool: poolB,
        poolSigner: poolBSigner,
        vaultAta: vaultB,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  });

  it("D) Multiple users & fairness (Pool A, 10% APY)", async () => {
    const other = Keypair.generate();
    await provider.connection.requestAirdrop(other.publicKey, 2e9);

    // Create ATA and mint funds to other
    await new Promise((r) => setTimeout(r, 2000));
    const otherAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection, user, mint, other.publicKey
    );
    await mintTo(provider.connection, user, mint, otherAtaAcc.address, user, Number(BigInt(1000) * ONE));

    const [userStakeA_other] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), poolA.toBuffer(), other.publicKey.toBuffer()],
      program.programId
    );

    // Reset time offset
    await program.methods.setTimeOffset(new BN(0)).accounts({ admin: user.publicKey, pool: poolA }).rpc();

    // t0: User A stakes 10
    await program.methods
      .stake(new BN(toBase(10)))
      .accounts({
        user: user.publicKey,
        userStake: (await PublicKey.findProgramAddress(
          [Buffer.from("user_stake"), poolA.toBuffer(), user.publicKey.toBuffer()],
          program.programId
        ).then(r => r)),
        userAta,
        pool: poolA,
        poolSigner: poolASigner,
        vaultAta: vaultA,
        mint,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    // After 10 days: User B stakes 10
    await program.methods.setTimeOffset(new BN(10 * 24 * 3600)).accounts({ admin: user.publicKey, pool: poolA }).rpc();
    await program.methods
      .stake(new BN(toBase(10)))
      .accounts({
        user: other.publicKey,
        userStake: userStakeA_other,
        userAta: otherAtaAcc.address,
        pool: poolA,
        poolSigner: poolASigner,
        vaultAta: vaultA,
        mint,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([other])
      .rpc();

    // After 20 more days (total 30), both claim
    await program.methods.setTimeOffset(new BN(30 * 24 * 3600)).accounts({ admin: user.publicKey, pool: poolA }).rpc();

    const beforeA = (await provider.connection.getTokenAccountBalance(userAta)).value.uiAmount!;
    await program.methods
      .claim()
      .accounts({
        user: user.publicKey,
        userStake: (await PublicKey.findProgramAddress(
          [Buffer.from("user_stake"), poolA.toBuffer(), user.publicKey.toBuffer()],
          program.programId
        ).then(r => r)),
        userAta,
        pool: poolA,
        poolSigner: poolASigner,
        vaultAta: vaultA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
    const afterA = (await provider.connection.getTokenAccountBalance(userAta)).value.uiAmount!;
    const earnedA = afterA - beforeA;

    const beforeB = (await provider.connection.getTokenAccountBalance(otherAtaAcc.address)).value.uiAmount!;
    await program.methods
      .claim()
      .accounts({
        user: other.publicKey,
        userStake: userStakeA_other,
        userAta: otherAtaAcc.address,
        pool: poolA,
        poolSigner: poolASigner,
        vaultAta: vaultA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([other])
      .rpc();
    const afterB = (await provider.connection.getTokenAccountBalance(otherAtaAcc.address)).value.uiAmount!;
    const earnedB = afterB - beforeB;

    const expA = rewardLinear(1000, 10, 30 * 24 * 3600);
    const expB = rewardLinear(1000, 10, 20 * 24 * 3600);
    expect(Math.abs(earnedA - expA)).to.be.lessThan(0.0001);
    expect(Math.abs(earnedB - expB)).to.be.lessThan(0.0001);
  });

  it("E) Edge cases", async () => {
    // Staking zero -> error
    let failed = false;
    try {
      await program.methods
        .stake(new BN(0))
        .accounts({
          user: user.publicKey,
          userStake: (await PublicKey.findProgramAddress(
            [Buffer.from("user_stake"), poolA.toBuffer(), user.publicKey.toBuffer()],
            program.programId
          ).then(r => r)),
          userAta,
          pool: poolA,
          poolSigner: poolASigner,
          vaultAta: vaultA,
          mint,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        })
        .rpc();
    } catch (e) {
      failed = true;
    }
    expect(failed).to.eq(true);

    // Claim with zero stake -> should not crash
    // Use a new user with no stake
    const temp = Keypair.generate();
    await provider.connection.requestAirdrop(temp.publicKey, 2e9);
    const [tempStake] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), poolA.toBuffer(), temp.publicKey.toBuffer()],
      program.programId
    );
    const tempAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      temp,
      mint,
      temp.publicKey
    );
    await program.methods
      .claim()
      .accounts({
        user: temp.publicKey,
        userStake: tempStake,
        userAta: tempAta.address,
        pool: poolA,
        poolSigner: poolASigner,
        vaultAta: vaultA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([temp])
      .rpc();

    // total_staked == 0 safe path covered implicitly when no one has staked
  });
});
