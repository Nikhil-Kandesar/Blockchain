import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AbcStaking as anchor.Program;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const connection = provider.connection;

  // Set mint from previous script output
  const mint = new PublicKey(process.env.ABC_MINT!);

  // Derive pool PDAs
  const [poolA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint.toBuffer(), payer.publicKey.toBuffer()],
    program.programId
  );
  const poolASigner = poolA; // same seeds

  const [poolB] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint.toBuffer(), payer.publicKey.toBuffer()],
    program.programId
  );
  const poolBSigner = poolB;

  // Create vault ATAs for pool signer
  const vaultA = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    poolASigner,
    true
  );
  const vaultB = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    poolBSigner,
    true
  );

  // Initialize Pool A: 10% APY, 0 lockup
  await program.methods
    .initializePool(1000, 0)
    .accounts({
      admin: payer.publicKey,
      pool: poolA,
      poolSigner: poolASigner,
      mint,
      vaultAta: vaultA.address,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  // Initialize Pool B: 20% APY, 30d lockup
  const lockup = 30 * 24 * 3600;
  await program.methods
    .initializePool(2000, lockup)
    .accounts({
      admin: payer.publicKey,
      pool: poolB,
      poolSigner: poolBSigner,
      mint,
      vaultAta: vaultB.address,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  console.log("Pool A:", poolA.toBase58(), "Vault:", vaultA.address.toBase58());
  console.log("Pool B:", poolB.toBase58(), "Vault:", vaultB.address.toBase58());
})();
