import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  generateSigner,
  keypairIdentity,
  publicKey as umiPublicKey,
} from "@metaplex-foundation/umi";
import {
  MPL_CORE_PROGRAM_ID,
  create as createAsset,
  fetchAssetV1,
  mplCore,
} from "@metaplex-foundation/mpl-core";
import { assert } from "chai";
import { AnchorMarketplaceCore } from "../target/types/anchor_marketplace_core";

describe("marketplace-core", () => {
  const provider = anchor.AnchorProvider.env();
  // Use "confirmed" so Anchor's RPCs and umi's reads both see the same state.
  // Anchor's default is "processed" and umi-bundle-defaults reads at "finalized"
  // (web3.js's default when no commitment is passed to `new Connection`), which
  // would otherwise return stale mpl-core asset state right after a tx returns.
  provider.opts.commitment = "confirmed";
  provider.opts.preflightCommitment = "confirmed";
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorMarketplaceCore as Program<AnchorMarketplaceCore>;
  const connection = provider.connection;

  const providerKeypair = (provider.wallet as anchor.Wallet).payer;
  // Pin umi's RPC commitment to "confirmed". web3.js's default is "finalized",
  // which lags behind on a local validator and causes umi reads to return stale
  // pre-transfer state right after a list/buy completes.
  const umi = createUmi(connection.rpcEndpoint, "confirmed").use(mplCore());
  umi.use(
    keypairIdentity(
      umi.eddsa.createKeypairFromSecretKey(providerKeypair.secretKey)
    )
  );

  const admin = Keypair.generate();
  const maker = Keypair.generate();
  const taker = Keypair.generate();

  const name = "turbin3";
  const fee = 250; // 2.5%

  const marketplacePda = PublicKey.findProgramAddressSync(
    [Buffer.from("marketplace"), Buffer.from(name)],
    program.programId
  )[0];

  const treasuryPda = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), marketplacePda.toBuffer()],
    program.programId
  )[0];

  const rewardsMintPda = PublicKey.findProgramAddressSync(
    [Buffer.from("rewards"), marketplacePda.toBuffer()],
    program.programId
  )[0];

  const listingPda = (asset: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), asset.toBuffer()],
      program.programId
    )[0];

  const fund = async (to: PublicKey, sol = 10) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.publicKey,
        toPubkey: to,
        lamports: sol * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
  };

  // The provider's wallet pays for asset creation; `owner` is the maker so
  // they can list/delist via Anchor RPC. `skipPreflight: true` bypasses a
  // umi+web3.js preflight bug on this Agave validator that reports
  // "Attempt to debit an account but found no record of a prior credit"
  // for transactions that execute correctly on-chain.
  const createCoreAsset = async (owner: PublicKey): Promise<PublicKey> => {
    const assetSigner = generateSigner(umi);
    await createAsset(umi, {
      asset: assetSigner,
      owner: umiPublicKey(owner.toBase58()),
      name: "Test Asset",
      uri: "https://example.com/test.json",
    }).sendAndConfirm(umi, {
      send: { skipPreflight: true },
    });
    return new PublicKey(assetSigner.publicKey);
  };

  before(async () => {
    await fund(admin.publicKey);
    await fund(maker.publicKey);
    await fund(taker.publicKey);
  });

  it("initializes the marketplace", async () => {
    await program.methods
      .initialize(name, fee)
      .accountsPartial({
        admin: admin.publicKey,
        marketplace: marketplacePda,
        treasury: treasuryPda,
        rewardMint: rewardsMintPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const mp = await program.account.marketplace.fetch(marketplacePda);
    assert.equal(mp.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(mp.fee, fee);
    assert.equal(mp.name, name);

    const mint = await getMint(connection, rewardsMintPda);
    assert.equal(mint.decimals, 6);
    assert.equal(mint.mintAuthority!.toBase58(), marketplacePda.toBase58());
  });

  let listedAsset: PublicKey;
  const listPrice = new BN(LAMPORTS_PER_SOL);

  it("lists an mpl-core asset", async () => {
    listedAsset = await createCoreAsset(maker.publicKey);

    await program.methods
      .list(listPrice)
      .accountsPartial({
        maker: maker.publicKey,
        asset: listedAsset,
        collection: null,
        listing: listingPda(listedAsset),
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const listing = await program.account.listing.fetch(listingPda(listedAsset));
    assert.equal(listing.maker.toBase58(), maker.publicKey.toBase58());
    assert.equal(listing.asset.toBase58(), listedAsset.toBase58());
    assert.equal(listing.price.toString(), listPrice.toString());

    const asset = await fetchAssetV1(umi, umiPublicKey(listedAsset.toBase58()));
    assert.equal(asset.owner.toString(), listingPda(listedAsset).toBase58());
  });

  it("lets a taker buy the listed asset", async () => {
    const takerRewardsAta = getAssociatedTokenAddressSync(
      rewardsMintPda,
      taker.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const makerBefore = await connection.getBalance(maker.publicKey);
    const treasuryBefore = await connection.getBalance(treasuryPda);
    const listingRent = await connection.getBalance(listingPda(listedAsset));

    await program.methods
      .buy()
      .accountsPartial({
        taker: taker.publicKey,
        maker: maker.publicKey,
        asset: listedAsset,
        collection: null,
        marketplace: marketplacePda,
        listing: listingPda(listedAsset),
        treasury: treasuryPda,
        rewardsMint: rewardsMintPda,
        takerRewardsAta,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    const asset = await fetchAssetV1(umi, umiPublicKey(listedAsset.toBase58()));
    assert.equal(asset.owner.toString(), taker.publicKey.toBase58());

    const listingAfter = await program.account.listing.fetchNullable(
      listingPda(listedAsset)
    );
    assert.isNull(listingAfter, "listing should be closed");

    const expectedFee = listPrice.muln(fee).divn(10_000).toNumber();
    const expectedMakerDelta =
      listPrice.toNumber() - expectedFee + listingRent;

    const makerAfter = await connection.getBalance(maker.publicKey);
    const treasuryAfter = await connection.getBalance(treasuryPda);
    assert.equal(makerAfter - makerBefore, expectedMakerDelta);
    assert.equal(treasuryAfter - treasuryBefore, expectedFee);

    const rewards = await getAccount(connection, takerRewardsAta);
    assert.equal(rewards.amount.toString(), "1");
  });

  it("rejects a self-buy (maker buying their own listing)", async () => {
    const asset = await createCoreAsset(maker.publicKey);

    await program.methods
      .list(new BN(0.5 * LAMPORTS_PER_SOL))
      .accountsPartial({
        maker: maker.publicKey,
        asset,
        collection: null,
        listing: listingPda(asset),
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const makerRewardsAta = getAssociatedTokenAddressSync(
      rewardsMintPda,
      maker.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      await program.methods
        .buy()
        .accountsPartial({
          taker: maker.publicKey,
          maker: maker.publicKey,
          asset,
          collection: null,
          marketplace: marketplacePda,
          listing: listingPda(asset),
          treasury: treasuryPda,
          rewardsMint: rewardsMintPda,
          takerRewardsAta: makerRewardsAta,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      assert.fail("expected self-buy to be rejected");
    } catch (err: any) {
      assert.include(err.toString(), "SelfBuyNotAllowed");
    }

    // cleanup so the listing doesn't leak into later tests
    await program.methods
      .delist()
      .accountsPartial({
        maker: maker.publicKey,
        asset,
        collection: null,
        marketplace: marketplacePda,
        listing: listingPda(asset),
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();
  });

  it("lets the maker delist an asset", async () => {
    const asset = await createCoreAsset(maker.publicKey);

    await program.methods
      .list(new BN(2 * LAMPORTS_PER_SOL))
      .accountsPartial({
        maker: maker.publicKey,
        asset,
        collection: null,
        listing: listingPda(asset),
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    await program.methods
      .delist()
      .accountsPartial({
        maker: maker.publicKey,
        asset,
        collection: null,
        marketplace: marketplacePda,
        listing: listingPda(asset),
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const fetched = await fetchAssetV1(umi, umiPublicKey(asset.toBase58()));
    assert.equal(fetched.owner.toString(), maker.publicKey.toBase58());

    const listingAfter = await program.account.listing.fetchNullable(
      listingPda(asset)
    );
    assert.isNull(listingAfter, "listing should be closed");
  });

  it("lets admin withdraw treasury fees", async () => {
    const treasuryBefore = await connection.getBalance(treasuryPda);
    assert.isAbove(treasuryBefore, 0, "treasury should have accumulated fees");

    const adminBefore = await connection.getBalance(admin.publicKey);
    const amount = Math.floor(treasuryBefore / 2);

    await program.methods
      .withdrawFees(new BN(amount))
      .accountsPartial({
        admin: admin.publicKey,
        marketplace: marketplacePda,
        treasury: treasuryPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const treasuryAfter = await connection.getBalance(treasuryPda);
    const adminAfter = await connection.getBalance(admin.publicKey);
    assert.equal(treasuryBefore - treasuryAfter, amount);
    assert.equal(adminAfter - adminBefore, amount);
  });

  it("rejects unauthorized and zero-amount withdrawals", async () => {
    const intruder = Keypair.generate();

    try {
      await program.methods
        .withdrawFees(new BN(1))
        .accountsPartial({
          admin: intruder.publicKey,
          marketplace: marketplacePda,
          treasury: treasuryPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([intruder])
        .rpc();
      assert.fail("expected non-admin withdraw to be rejected");
    } catch (err: any) {
      assert.include(err.toString(), "ConstraintHasOne");
    }

    try {
      await program.methods
        .withdrawFees(new BN(0))
        .accountsPartial({
          admin: admin.publicKey,
          marketplace: marketplacePda,
          treasury: treasuryPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      assert.fail("expected zero-amount withdraw to be rejected");
    } catch (err: any) {
      assert.include(err.toString(), "InvalidWithdrawAmount");
    }
  });
});
