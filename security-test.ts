import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  Chain,
  Tx,
  Block,
  MIN_FEE,
  blockRewardAtHeight,
  minRelayFeeForTx,
} from "./chain";

import {
  flushAsyncDiskQueue,
} from "./async-disk";

type Wallet = {
  publicKey: string;
  privateKey: string;
};

let passed = 0;
let failed = 0;

function pass(name: string) {
  passed++;
  console.log(`PASS  ${name}`);
}

function fail(name: string, reason?: unknown) {
  failed++;
  console.log(`FAIL  ${name}${reason ? ` — ${String(reason)}` : ""}`);
}

function expect(name: string, condition: boolean) {
  if (condition) pass(name);
  else fail(name);
}

function wallet(): Wallet {
  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  return {
    publicKey: pair.publicKey
      .export({ type: "pkcs1", format: "pem" })
      .toString(),
    privateKey: pair.privateKey
      .export({ type: "pkcs1", format: "pem" })
      .toString(),
  };
}

function isolatedChain(tempDir: string, name: string) {
  const chain = new Chain();
  chain.chainFile = path.join(tempDir, `${name}.json`);
  return chain;
}

function signedTransfer(
  from: Wallet,
  to: Wallet,
  amount: number,
  fee: number,
  nonce: number
) {
  const tx = new Tx({
    type: "TRANSFER",
    from: from.publicKey,
    to: to.publicKey,
    amount,
    fee,
    nonce,
  });

  tx.sign(from.privateKey);
  return tx;
}

function relayCompliantTransfer(
  from: Wallet,
  to: Wallet,
  amount: number,
  nonce: number
) {
  let fee = MIN_FEE;

  for (let i = 0; i < 5; i++) {
    const tx = signedTransfer(
      from,
      to,
      amount,
      fee,
      nonce
    );

    const required = Math.max(
      MIN_FEE,
      minRelayFeeForTx(tx)
    );

    if (fee >= required) {
      return tx;
    }

    fee = required;
  }

  throw new Error("could not calculate relay-compliant fee");
}

function mineAndAdd(chain: Chain, miner: Wallet) {
  const block = chain.buildBlock(miner.publicKey);
  block.mine();

  if (!chain.tryAddBlock(block)) {
    throw new Error(`could not add block at height ${chain.height() + 1}`);
  }

  return block;
}

function mineBlocks(chain: Chain, miner: Wallet, count: number) {
  for (let i = 0; i < count; i++) {
    mineAndAdd(chain, miner);
  }
}

function cloneChainFrom(
  source: Chain,
  tempDir: string,
  name: string
) {
  const clone = new Chain();
  clone.chainFile = path.join(tempDir, `${name}.json`);

  const raw = source.blocks.map((block) => block.toJSON());

  if (!clone.tryAdoptChain(raw)) {
    throw new Error(`could not clone chain into ${name}`);
  }

  return clone;
}

async function main() {
  console.log("");
  console.log("====================================");
  console.log(" DUBZCHAIN LAYER 1 SECURITY SUITE");
  console.log("====================================");
  console.log("");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "dubzchain-security-")
  );

  console.log(`isolated test dir: ${tempDir}`);
  console.log("");

  try {
    const fundedMiner = wallet();

    console.log("Preparing funded test chain once...");
    const fundedBase = isolatedChain(tempDir, "funded-base");
    mineBlocks(fundedBase, fundedMiner, 34);
    await flushAsyncDiskQueue();
    console.log("Funded test chain ready.");
    console.log("");

    /*
     * Test 1:
     * A freshly signed transaction should have a valid signature.
     */
    {
      const alice = wallet();
      const bob = wallet();

      const tx = signedTransfer(
        alice,
        bob,
        10,
        MIN_FEE,
        1
      );

      expect("valid transaction signature", tx.verify());
    }

    /*
     * Test 2:
     * Modifying a signed transaction must invalidate its signature.
     */
    {
      const alice = wallet();
      const bob = wallet();

      const tx = signedTransfer(
        alice,
        bob,
        10,
        MIN_FEE,
        1
      );

      tx.amount = 11;

      expect("tampered signature rejected", !tx.verify());
    }

    /*
     * Test 3:
     * A block produced by buildBlock + PoW should validate.
     */
    {
      const miner = wallet();
      const chain = isolatedChain(tempDir, "valid-block");

      const block = chain.buildBlock(miner.publicKey);
      block.mine();

      expect("valid mined block accepted", chain.validateBlock(block));
    }

    /*
     * Test 4:
     * A block with a corrupted hash must not be accepted.
     */
    {
      const miner = wallet();
      const chain = isolatedChain(tempDir, "bad-hash");

      const block = chain.buildBlock(miner.publicKey);
      block.mine();

      block.hash =
        "f".repeat(64);

      expect("tampered block hash rejected", !chain.validateBlock(block));
    }

    /*
     * Test 5:
     * A block whose coinbase amount is changed must fail validation.
     */
    {
      const miner = wallet();
      const chain = isolatedChain(tempDir, "bad-coinbase");

      const block = chain.buildBlock(miner.publicKey);

      const coinbase = block.txs[0];
      coinbase.amount =
        blockRewardAtHeight(chain.height() + 1) + 1;

      block.hash = block.computeHash();
      block.mine();

      expect("bad coinbase reward rejected", !chain.validateBlock(block));
    }

    /*
     * Test 6:
     * Once a block has been accepted, the same block cannot be added again.
     */
    {
      const miner = wallet();
      const chain = isolatedChain(tempDir, "duplicate-block");

      const block = mineAndAdd(chain, miner);

      expect("duplicate block rejected", !chain.tryAddBlock(block));
    }

    /*
     * Test 7:
     * Full replay validation should succeed for an internally generated chain.
     */
    {
      const miner = wallet();
      const chain = isolatedChain(tempDir, "replay");

      mineBlocks(chain, miner, 3);

      expect("full chain replay validation", chain.validateChain(chain.blocks));
    }


    /*
     * Test 8:
     * Fee below MIN_FEE must be rejected by the mempool.
     */
    {
      const miner = fundedMiner;
      const receiver = wallet();
      const chain = cloneChainFrom(fundedBase, tempDir, "low-fee");

      const tx = signedTransfer(
        miner,
        receiver,
        1,
        Math.max(0, MIN_FEE - 1),
        chain.nextNonce(miner.publicKey)
      );

      expect("fee below minimum rejected", !chain.addToMempool(tx));
    }

    /*
     * Test 9:
     * A nonce gap must be rejected.
     */
    {
      const miner = fundedMiner;
      const receiver = wallet();
      const chain = cloneChainFrom(fundedBase, tempDir, "skipped-nonce");

      const tx = relayCompliantTransfer(
        miner,
        receiver,
        1,
        chain.nextNonce(miner.publicKey) + 1
      );

      expect("skipped nonce rejected", !chain.addToMempool(tx));
    }

    /*
     * Test 10:
     * Once a transaction is accepted into the mempool,
     * submitting the same transaction again must fail.
     */
    {
      const miner = fundedMiner;
      const receiver = wallet();
      const chain = cloneChainFrom(fundedBase, tempDir, "duplicate-tx");

      const tx = relayCompliantTransfer(
        miner,
        receiver,
        1,
        chain.nextNonce(miner.publicKey)
      );

      const first = chain.addToMempool(tx);
      const second = chain.addToMempool(tx);

      expect("valid transaction enters mempool", first);
      expect("duplicate transaction rejected", !second);
    }

    /*
     * Test 11:
     * Spending more than the available spendable balance must fail.
     */
    {
      const alice = wallet();
      const bob = wallet();
      const chain = isolatedChain(tempDir, "insufficient");

      const tx = relayCompliantTransfer(
        alice,
        bob,
        1,
        1
      );

      expect("insufficient balance rejected", !chain.addToMempool(tx));
    }

    /*
     * Test 12:
     * A reused confirmed nonce must fail.
     */
    {
      const miner = fundedMiner;
      const receiver = wallet();
      const chain = cloneChainFrom(fundedBase, tempDir, "reused-nonce");

      const tx1 = relayCompliantTransfer(
        miner,
        receiver,
        1,
        chain.nextNonce(miner.publicKey)
      );

      const accepted = chain.addToMempool(tx1);

      if (!accepted) {
        fail("setup transaction accepted for reused nonce");
      } else {
        mineAndAdd(chain, miner);

        const replay = relayCompliantTransfer(
          miner,
          receiver,
          1,
          tx1.nonce
        );

        expect("reused confirmed nonce rejected", !chain.addToMempool(replay));
      }
    }

    /*
     * Test 13:
     * A COINBASE transaction must never enter the mempool.
     */
    {
      const miner = wallet();
      const chain = isolatedChain(tempDir, "coinbase-mempool");

      const tx = new Tx({
        type: "COINBASE",
        from: null,
        to: miner.publicKey,
        amount: blockRewardAtHeight(1),
        fee: 0,
        nonce: 0,
      });

      expect("coinbase transaction rejected from mempool", !chain.addToMempool(tx));
    }

    /*
     * Test 14:
     * Mutating historical block data must cause full replay validation to fail.
     */
    {
      const miner = wallet();
      const chain = isolatedChain(tempDir, "mutated-history");

      mineBlocks(chain, miner, 3);

      const mutated = chain.blocks.map((block) =>
        Block.fromJSON(block.toJSON())
      );

      mutated[1].nonce += 1;

      expect(
        "mutated historical chain rejected",
        !chain.validateChain(mutated)
      );
    }

  } catch (err) {
    fail("security suite execution", err);
  } finally {
    try {
      await flushAsyncDiskQueue();
    } catch (err) {
      console.log("WARN  async disk flush failed:", String(err));
    }

    try {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
      });
    } catch {}
  }

  console.log("");
  console.log("------------------------------------");
  console.log(`${passed} passed`);
  console.log(`${failed} failed`);
  console.log("------------------------------------");
  console.log("");

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
