import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Create ABC mint with 9 decimals
  const decimals = 9;
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    decimals
  );

  // Create user ATA and mint 1,000 ABC
  const userAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey
  );

  const amount = BigInt(1_000) * BigInt(10 ** decimals);
  await mintTo(connection, payer, mint, userAta.address, payer, Number(amount));

  console.log("ABC mint:", mint.toBase58());
  console.log("User ATA:", userAta.address.toBase58());
})();
