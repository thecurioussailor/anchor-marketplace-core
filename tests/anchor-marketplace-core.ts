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
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
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

  const offerPda = (asset: PublicKey, buyer: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), asset.toBuffer(), buyer.toBuffer()],
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
        paymentMint: null,
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
        paymentMint: null,
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
        paymentMint: null,
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

  describe("buy_with_token (SPL payment listings)", () => {
    let paymentMint: PublicKey;
    let tokenListedAsset: PublicKey;
    const tokenPrice = new BN(1_000_000); // 1 token at 6 decimals

    before(async () => {
      paymentMint = await createMint(
        connection,
        providerKeypair,
        providerKeypair.publicKey,
        null,
        6
      );

      const takerAta = await getOrCreateAssociatedTokenAccount(
        connection,
        providerKeypair,
        paymentMint,
        taker.publicKey
      );
      await mintTo(
        connection,
        providerKeypair,
        paymentMint,
        takerAta.address,
        providerKeypair,
        10_000_000
      );
    });

    it("lists an asset priced in an SPL token", async () => {
      tokenListedAsset = await createCoreAsset(maker.publicKey);

      await program.methods
        .list(tokenPrice)
        .accountsPartial({
          maker: maker.publicKey,
          asset: tokenListedAsset,
          collection: null,
          listing: listingPda(tokenListedAsset),
          paymentMint,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();

      const listing = await program.account.listing.fetch(
        listingPda(tokenListedAsset)
      );
      assert.equal(listing.price.toString(), tokenPrice.toString());
      assert.equal(listing.paymentMint.toBase58(), paymentMint.toBase58());

      const asset = await fetchAssetV1(umi, umiPublicKey(tokenListedAsset.toBase58()));
      assert.equal(asset.owner.toString(), listingPda(tokenListedAsset).toBase58());
    });

    it("lets a taker buy the listing with the SPL token", async () => {
      const takerPaymentAta = getAssociatedTokenAddressSync(
        paymentMint,
        taker.publicKey
      );
      const makerPaymentAta = getAssociatedTokenAddressSync(
        paymentMint,
        maker.publicKey
      );
      const treasuryTokenAccount = getAssociatedTokenAddressSync(
        paymentMint,
        marketplacePda,
        true
      );
      const takerRewardsAta = getAssociatedTokenAddressSync(
        rewardsMintPda,
        taker.publicKey
      );

      const takerBefore = await getAccount(connection, takerPaymentAta);

      await program.methods
        .buyWithToken()
        .accountsPartial({
          taker: taker.publicKey,
          maker: maker.publicKey,
          asset: tokenListedAsset,
          collection: null,
          marketplace: marketplacePda,
          listing: listingPda(tokenListedAsset),
          paymentMint,
          takerPaymentAta,
          makerPaymentAta,
          treasuryTokenAccount,
          rewardsMint: rewardsMintPda,
          takerRewardsAta,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();

      const asset = await fetchAssetV1(umi, umiPublicKey(tokenListedAsset.toBase58()));
      assert.equal(asset.owner.toString(), taker.publicKey.toBase58());

      const listingAfter = await program.account.listing.fetchNullable(
        listingPda(tokenListedAsset)
      );
      assert.isNull(listingAfter, "listing should be closed");

      const expectedFee = tokenPrice.muln(fee).divn(10_000).toNumber();
      const expectedMakerAmount = tokenPrice.toNumber() - expectedFee;

      const takerAfter = await getAccount(connection, takerPaymentAta);
      const makerAfter = await getAccount(connection, makerPaymentAta);
      const treasuryAfter = await getAccount(connection, treasuryTokenAccount);

      assert.equal(
        (takerBefore.amount - takerAfter.amount).toString(),
        tokenPrice.toString()
      );
      assert.equal(makerAfter.amount.toString(), expectedMakerAmount.toString());
      assert.equal(treasuryAfter.amount.toString(), expectedFee.toString());

      // taker already holds 1 reward token from the earlier SOL `buy` test
      const rewards = await getAccount(connection, takerRewardsAta);
      assert.equal(rewards.amount.toString(), "2");
    });

    it("lets admin withdraw SPL treasury fees", async () => {
      const treasuryTokenAccount = getAssociatedTokenAddressSync(
        paymentMint,
        marketplacePda,
        true
      );
      const adminTokenAccount = getAssociatedTokenAddressSync(
        paymentMint,
        admin.publicKey
      );

      const treasuryBefore = await getAccount(connection, treasuryTokenAccount);
      assert.isAbove(
        Number(treasuryBefore.amount),
        0,
        "treasury token account should have accumulated fees"
      );

      const amount = treasuryBefore.amount;

      await program.methods
        .withdrawTokenFees(new BN(amount.toString()))
        .accountsPartial({
          admin: admin.publicKey,
          marketplace: marketplacePda,
          paymentMint,
          treasuryTokenAccount,
          adminTokenAccount,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const treasuryAfter = await getAccount(connection, treasuryTokenAccount);
      const adminAfter = await getAccount(connection, adminTokenAccount);
      assert.equal(treasuryAfter.amount.toString(), "0");
      assert.equal(adminAfter.amount.toString(), amount.toString());
    });

    it("rejects unauthorized and zero-amount SPL withdrawals", async () => {
      const intruder = Keypair.generate();
      await fund(intruder.publicKey, 1);

      const treasuryTokenAccount = getAssociatedTokenAddressSync(
        paymentMint,
        marketplacePda,
        true
      );
      const intruderTokenAccount = getAssociatedTokenAddressSync(
        paymentMint,
        intruder.publicKey
      );
      const adminTokenAccount = getAssociatedTokenAddressSync(
        paymentMint,
        admin.publicKey
      );

      try {
        await program.methods
          .withdrawTokenFees(new BN(1))
          .accountsPartial({
            admin: intruder.publicKey,
            marketplace: marketplacePda,
            paymentMint,
            treasuryTokenAccount,
            adminTokenAccount: intruderTokenAccount,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
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
          .withdrawTokenFees(new BN(0))
          .accountsPartial({
            admin: admin.publicKey,
            marketplace: marketplacePda,
            paymentMint,
            treasuryTokenAccount,
            adminTokenAccount,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
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

  describe("offers (make_offer / accept_offer / cancel_offer)", () => {
    let offerAsset: PublicKey;
    const listPriceForOffer = new BN(2 * LAMPORTS_PER_SOL);
    const offerAmount = new BN(1.5 * LAMPORTS_PER_SOL);

    before(async () => {
      offerAsset = await createCoreAsset(maker.publicKey);

      await program.methods
        .list(listPriceForOffer)
        .accountsPartial({
          maker: maker.publicKey,
          asset: offerAsset,
          collection: null,
          listing: listingPda(offerAsset),
          paymentMint: null,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
    });

    it("lets a buyer make an offer (escrowing SOL)", async () => {
      await program.methods
        .makeOffer(offerAmount)
        .accountsPartial({
          buyer: taker.publicKey,
          asset: offerAsset,
          offer: offerPda(offerAsset, taker.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();

      const offer = await program.account.offer.fetch(
        offerPda(offerAsset, taker.publicKey)
      );
      assert.equal(offer.buyer.toBase58(), taker.publicKey.toBase58());
      assert.equal(offer.asset.toBase58(), offerAsset.toBase58());
      assert.equal(offer.amount.toString(), offerAmount.toString());

      const offerBalance = await connection.getBalance(
        offerPda(offerAsset, taker.publicKey)
      );
      assert.isAtLeast(offerBalance, offerAmount.toNumber());
    });

    it("lets the maker accept the offer", async () => {
      const buyerRewardsAta = getAssociatedTokenAddressSync(
        rewardsMintPda,
        taker.publicKey
      );

      const makerBefore = await connection.getBalance(maker.publicKey);
      const treasuryBefore = await connection.getBalance(treasuryPda);
      const buyerBefore = await connection.getBalance(taker.publicKey);

      await program.methods
        .acceptOffer()
        .accountsPartial({
          maker: maker.publicKey,
          buyer: taker.publicKey,
          asset: offerAsset,
          collection: null,
          marketplace: marketplacePda,
          listing: listingPda(offerAsset),
          offer: offerPda(offerAsset, taker.publicKey),
          treasury: treasuryPda,
          rewardsMint: rewardsMintPda,
          buyerRewardsAta,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();

      const asset = await fetchAssetV1(umi, umiPublicKey(offerAsset.toBase58()));
      assert.equal(asset.owner.toString(), taker.publicKey.toBase58());

      const listingAfter = await program.account.listing.fetchNullable(
        listingPda(offerAsset)
      );
      assert.isNull(listingAfter, "listing should be closed");

      const offerAfter = await program.account.offer.fetchNullable(
        offerPda(offerAsset, taker.publicKey)
      );
      assert.isNull(offerAfter, "offer should be closed");

      const expectedFee = offerAmount.muln(fee).divn(10_000).toNumber();
      const expectedMakerDelta = offerAmount.toNumber() - expectedFee;

      const makerAfter = await connection.getBalance(maker.publicKey);
      const treasuryAfter = await connection.getBalance(treasuryPda);
      const buyerAfter = await connection.getBalance(taker.publicKey);

      // maker also reclaims the closed listing account's rent on top of
      // the offer payout
      assert.isAtLeast(makerAfter - makerBefore, expectedMakerDelta);
      assert.equal(treasuryAfter - treasuryBefore, expectedFee);
      // buyer gets back the offer-account rent (escrow minus the
      // amount that was paid out to maker/treasury)
      assert.isAbove(buyerAfter, buyerBefore);

      // taker has accumulated 2 rewards from earlier buy / buy_with_token
      // tests, plus 1 more from this accept_offer
      const rewards = await getAccount(connection, buyerRewardsAta);
      assert.equal(rewards.amount.toString(), "3");
    });

    it("lets a buyer cancel an offer and reclaim escrowed SOL", async () => {
      const cancelAsset = await createCoreAsset(maker.publicKey);
      const cancelAmount = new BN(0.5 * LAMPORTS_PER_SOL);

      await program.methods
        .makeOffer(cancelAmount)
        .accountsPartial({
          buyer: taker.publicKey,
          asset: cancelAsset,
          offer: offerPda(cancelAsset, taker.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();

      const buyerBefore = await connection.getBalance(taker.publicKey);

      await program.methods
        .cancelOffer()
        .accountsPartial({
          buyer: taker.publicKey,
          asset: cancelAsset,
          offer: offerPda(cancelAsset, taker.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();

      const buyerAfter = await connection.getBalance(taker.publicKey);
      assert.isAbove(buyerAfter, buyerBefore, "buyer should reclaim escrowed SOL");

      const offerAfter = await program.account.offer.fetchNullable(
        offerPda(cancelAsset, taker.publicKey)
      );
      assert.isNull(offerAfter, "offer should be closed");
    });
  });
});
