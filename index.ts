// index.ts
import * as http from "http";
import { startServer, connectToPeer, broadcastBlock } from "./network";
import { startRpcServer } from "./rpc";
import {
  readJSON,
  loadWalletFromFile,
  resolveAddressToPublicKey,
  submitTxToLocalNode,
  buildSignedTransferTx,
  makeShortAddress,
  makeEnsureWallet,
} from "./wallet";
import {
  usage,
  argValue,
  argHas,
  collectBootstrapPeers,
  connectBootstrapPeers,
  printBootstrapPlan,
} from "./runtime";
import {
  Chain,
  Tx,
  Block,
  CHAIN_ID,
  PROTOCOL_VERSION,
  NETWORK_MAGIC,
  MAX_SUPPLY,
  MIN_FEE,
  blockRewardAtHeight,
  verifyStateProof,
} from "./chain";

export {
  Chain,
  Tx,
  Block,
  CHAIN_ID,
  PROTOCOL_VERSION,
  NETWORK_MAGIC,
  MAX_SUPPLY,
  MIN_FEE,
  blockRewardAtHeight,
  verifyStateProof,
} from "./chain";

/* =========================
   Helpers
========================= */
import * as crypto from "crypto";
import * as fs from "fs";
import * as zlib from "zlib";
import WebSocket from "ws";

function sha256(data: string | Buffer) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
const shortAddress = makeShortAddress(sha256);

function writeJSON(path: string, obj: any) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
}
const ensureWallet = makeEnsureWallet(writeJSON);

function isSafeInt(n: any) {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
function readRequestBody(req: http.IncomingMessage, limitBytes = 256_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limitBytes) {
        reject(new Error("request body too large"));
        try {
          req.destroy();
        } catch {}
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

function randomReqId() {
  return `req_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

async function requestP2PProof(args: {
  peerUrl: string;
  kind: "balance" | "nonce" | "pending" | "minted";
  address?: string;
  pendingIndex?: number;
  timeoutMs?: number;
}) {
  return new Promise<any>((resolve) => {
    let done = false;
    const finish = (value: any) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    const reqId = randomReqId();
    const timeoutMs = Math.max(1000, args.timeoutMs ?? 4000);

    function tryExtractProofResponse(rawMsg: any): any | null {
      if (!rawMsg || typeof rawMsg !== "object") return null;
      if (rawMsg.magic !== NETWORK_MAGIC) return null;
      if (rawMsg.chainId !== CHAIN_ID) return null;
      if (rawMsg.version !== PROTOCOL_VERSION) return null;

      if (rawMsg.type === "PROOF_RESPONSE") {
        return rawMsg.reqId === reqId ? rawMsg : null;
      }

      if (
        rawMsg.type === "COMPRESSED" &&
        rawMsg.codec === "gzip" &&
        rawMsg.innerType === "PROOF_RESPONSE" &&
        typeof rawMsg.payloadBase64 === "string"
      ) {
        try {
          const gz = Buffer.from(rawMsg.payloadBase64, "base64");
          const inflated = zlib.gunzipSync(gz).toString("utf8");
          const inner = JSON.parse(inflated);

          if (!inner || typeof inner !== "object") return null;
          if (inner.magic !== NETWORK_MAGIC) return null;
          if (inner.chainId !== CHAIN_ID) return null;
          if (inner.version !== PROTOCOL_VERSION) return null;
          if (inner.type !== "PROOF_RESPONSE") return null;
          if (inner.reqId !== reqId) return null;

          return inner;
        } catch {
          return null;
        }
      }

      return null;
    }

    try {
      const ws = new WebSocket(args.peerUrl, { handshakeTimeout: 3000 });
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        finish({ ok: false, error: "timeout" });
      }, timeoutMs);

      ws.on("open", () => {
        const msg: any = {
          magic: NETWORK_MAGIC,
          chainId: CHAIN_ID,
          version: PROTOCOL_VERSION,
          type: "PROOF_REQUEST",
          kind: args.kind,
          reqId,
        };
        if (args.address) msg.address = args.address;
        if (typeof args.pendingIndex === "number") msg.pendingIndex = args.pendingIndex;
        ws.send(JSON.stringify(msg));
      });

      ws.on("message", (raw) => {
        try {
          const text = typeof raw === "string" ? raw : raw.toString("utf8");
          const parsed = JSON.parse(text);
          const proofResp = tryExtractProofResponse(parsed);
          if (!proofResp) return;

          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          finish(proofResp);
        } catch {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          finish({ ok: false, error: "bad-response" });
        }
      });

      ws.on("error", () => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        finish({ ok: false, error: "socket-error" });
      });

      ws.on("close", () => {
        clearTimeout(timer);
      });
    } catch {
      finish({ ok: false, error: "connect-failed" });
    }
  });
}

async function main() {
  const portStr = process.argv[2];
  if (!portStr) return usage();

  const port = parseInt(portStr, 10);
  const positionalPeerUrl = process.argv[3]?.startsWith("ws://") ? process.argv[3] : null;

  const host = argValue(process.argv, "--host") || "127.0.0.1";
  const rpcHost = argValue(process.argv, "--rpc-host") || "127.0.0.1";
  const advertise = argValue(process.argv, "--advertise");
  const bootstrapOnly = argHas(process.argv, "--bootstrap-only");
  const bootstrapWaitMsRaw = parseInt(argValue(process.argv, "--bootstrap-wait-ms") || "5000", 10);
  const bootstrapWaitMs = Number.isFinite(bootstrapWaitMsRaw) ? Math.max(0, bootstrapWaitMsRaw) : 5000;

  const bootstrapPeers = collectBootstrapPeers({
    argv: process.argv,
    positionalPeerUrl,
  });

  const chainFile = `dubzchain.${port}.json`;
  const walletFile = `wallet.miner.${port}.json`;

  const chain = Chain.instance;
  const chainFileExists = fs.existsSync(chainFile);
  const ok = chain.load(chainFile);

  if (ok) {
    console.log(`📦 Loaded chain from ${chainFile} (blocks=${chain.blocks.length})`);
  } else if (chainFileExists) {
    console.error(`❌ Existing chain file could not be loaded and backup recovery failed: ${chainFile}`);
    process.exit(1);
  } else {
    chain.save();
    console.log(`✅ Created new chain at ${chainFile}`);
  }

  const miner = ensureWallet(walletFile, shortAddress);

  const miningRuntime = {
    enabled: false,
    active: false,
    paused: false,
    stopRequested: false,
    controlState: "stopped" as "running" | "paused" | "stopped",
    mineEmpty: false,
    intervalMs: 0,
    yieldEvery: 0,
    minerWalletFile: walletFile,
    minerAddress: shortAddress(miner.publicKey),
    startedAt: null as number | null,
    currentHeight: null as number | null,
    difficulty: null as number | null,
    nonce: 0,
    attempts: 0,
    hashRate: 0,
    currentHash: null as string | null,
    blocksMined: 0,
    totalSubsidy: 0,
    totalFees: 0,
    history: [] as Array<{
      height: number;
      hash: string;
      nonce: number;
      difficulty: number;
      txCount: number;
      subsidy: number;
      fees: number;
      totalReward: number;
      minedAt: number;
    }>,
    lastBlock: null as null | {
      height: number;
      hash: string;
      nonce: number;
      difficulty: number;
      txCount: number;
      subsidy: number;
      fees: number;
      minedAt: number;
    },
  };

  function controlMining(
    action: "start" | "pause" | "resume" | "stop"
  ) {
    if (action === "start") {
      miningRuntime.enabled = true;
      miningRuntime.paused = false;
      miningRuntime.stopRequested = false;
      miningRuntime.controlState = "running";

      console.log("▶️ Mining started through RPC");

      return {
        ok: true,
        action,
        message: "Mining started",
      };
    }

    if (action === "pause") {
      miningRuntime.paused = true;
      miningRuntime.stopRequested = true;
      miningRuntime.controlState = "paused";

      console.log("⏸️ Mining paused through RPC");

      return {
        ok: true,
        action,
        message: "Mining paused",
      };
    }

    if (action === "resume") {
      miningRuntime.enabled = true;
      miningRuntime.paused = false;
      miningRuntime.stopRequested = false;
      miningRuntime.controlState = "running";

      console.log("▶️ Mining resumed through RPC");

      return {
        ok: true,
        action,
        message: "Mining resumed",
      };
    }

    miningRuntime.enabled = false;
    miningRuntime.paused = false;
    miningRuntime.stopRequested = true;
    miningRuntime.controlState = "stopped";

    console.log("⏹️ Mining stopped through RPC");

    return {
      ok: true,
      action,
      message: "Mining stopped",
    };
  }

  console.log(`🔑 Loaded wallet: ${walletFile}`);
  console.log(`⛏️ Miner: ${shortAddress(miner.publicKey)}`);
  console.log(`🧬 chainId=${CHAIN_ID} v${PROTOCOL_VERSION} magic=0x${NETWORK_MAGIC.toString(16)}`);

  /* =========================
     CLIENT-ONLY SEND MODE
     Fix #1: --send no longer tries to bind P2P/RPC ports
  ========================= */
  if (argHas(process.argv, "--send")) {
    const i = process.argv.indexOf("--send");
    const toWalletFile = process.argv[i + 1];
    const amountStr = process.argv[i + 2];

    if (!toWalletFile || !amountStr) {
      console.log("Missing --send args");
      return;
    }

    const toW = readJSON(toWalletFile);
    if (!toW?.publicKey) {
      console.log("Bad receiver wallet file");
      return;
    }

    const amount = parseInt(amountStr, 10);
    if (!isSafeInt(amount) || amount <= 0) {
      console.log("Bad amount");
      return;
    }

    const fee = MIN_FEE;
    const nonce = chain.nextNonce(miner.publicKey);

    const tx = buildSignedTransferTx({
      Tx,
      fromWallet: miner,
      toPublicKey: toW.publicKey,
      amount,
      fee,
      nonce,
    });

    console.log(
      `📨 client-send prepared | tx=${tx.id} | nonce=${nonce} | amount=${amount} | fee=${fee} | target=ws://127.0.0.1:${port}`
    );

    const okNet = await submitTxToLocalNode(port, tx, {
      networkMagic: NETWORK_MAGIC,
      chainId: CHAIN_ID,
      protocolVersion: PROTOCOL_VERSION,
    });

    if (okNet) {
      console.log(`✅ TX sent to running node ws://127.0.0.1:${port}: ${tx.id}`);
      return;
    }

    console.log(`❌ TX submit failed. Make sure node ${port} is already running before using --send.`);
    return;
  }

  printBootstrapPlan({
    port,
    host,
    rpcHost,
    advertise: advertise || null,
    peers: bootstrapPeers,
    bootstrapOnly,
    bootstrapWaitMs,
  });

  startServer({
    port,
    host,
    advertiseUrl: advertise,
  });

  startRpcServer({
    port,
    minerWalletFile: walletFile,
    rpcHost,
    chainId: CHAIN_ID,
    protocolVersion: PROTOCOL_VERSION,
    maxSupply: MAX_SUPPLY,
    minFee: MIN_FEE,
    chain,
    Tx,
    shortAddress,
    resolveAddressToPublicKey: (input: string) => resolveAddressToPublicKey(input, shortAddress),
    loadWalletFromFile,
    readRequestBody,
    submitTxToLocalNode: (p: number, tx: any) =>
      submitTxToLocalNode(p, tx, {
        networkMagic: NETWORK_MAGIC,
        chainId: CHAIN_ID,
        protocolVersion: PROTOCOL_VERSION,
      }),
    blockRewardAtHeight,
    verifyStateProof,
    controlMining,
    getMiningStatus: () => ({
      ...miningRuntime,
      elapsedMs:
        miningRuntime.active && miningRuntime.startedAt
          ? Date.now() - miningRuntime.startedAt
          : 0,
    }),
  });

  console.log(`🚀 DubzNode running on ws://${host}:${port}`);
  if (advertise) {
    console.log(`📣 Advertised peer: ${advertise}`);
  }
  if (host === "0.0.0.0") {
    console.log(`🌍 Public/LAN binding enabled on port ${port}`);
  }

  const startedBootstrap = await connectBootstrapPeers(bootstrapPeers, connectToPeer);
  if (startedBootstrap > 0) {
    console.log(`🌱 Bootstrap dials started: ${startedBootstrap}/${bootstrapPeers.length}`);
  } else if (bootstrapPeers.length > 0) {
    console.log(`🌱 Bootstrap dials started: 0/${bootstrapPeers.length}`);
  }

  if (bootstrapOnly) {
    console.log(`⏳ Bootstrap-only mode waiting ${bootstrapWaitMs}ms...`);
    await sleep(bootstrapWaitMs);
    console.log(`📏 Height after bootstrap wait: ${chain.height()}`);
    console.log(`🌳 Tip after bootstrap wait: ${chain.tipHash()}`);
    return;
  }

  if (bootstrapPeers.length > 0 && bootstrapWaitMs > 0) {
    console.log(`⏳ Initial bootstrap wait ${bootstrapWaitMs}ms before continuing...`);
    await sleep(bootstrapWaitMs);
    console.log(`📏 Height after bootstrap wait: ${chain.height()}`);
  }

  if (argHas(process.argv, "--balance")) {
    const spendable = chain.getSpendable(miner.publicKey);
    const immature = chain.getImmature(miner.publicKey);
    const total = spendable + immature;

    console.log(`💰 Spendable: ${spendable} DUBZ`);
    console.log(`🧊 Immature: ${immature} DUBZ`);
    console.log(`💎 Total: ${total} DUBZ`);
    console.log(`🧾 Nonce: confirmed=${chain.confirmedNonce(miner.publicKey)} next=${chain.nextNonce(miner.publicKey)}`);
    console.log(`📏 Height: ${chain.height()}`);
    console.log(`🪶 Orphans: ${chain.orphanCount()}`);
    console.log(`🏦 Supply(est): ${chain.getState().minted} / ${MAX_SUPPLY}`);
    console.log(`🎁 Reward now (subsidy): ${blockRewardAtHeight(chain.height() + 1)} DUBZ`);
    console.log(`🌳 Tip stateRoot: ${chain.blocks[chain.blocks.length - 1].stateRoot}`);
    return;
  }

  if (argHas(process.argv, "--proof-balance")) {
    const wf = argValue(process.argv, "--proof-balance") || walletFile;
    const w = readJSON(wf);
    if (!w?.publicKey) return console.log("Bad wallet file for --proof-balance");

    const proof = chain.getBalanceProof(w.publicKey);
    if (!proof) return console.log("No balance proof available for that wallet");

    console.log(JSON.stringify(proof, null, 2));
    console.log(`verify=${verifyStateProof(proof)}`);
    return;
  }

  if (argHas(process.argv, "--proof-nonce")) {
    const wf = argValue(process.argv, "--proof-nonce") || walletFile;
    const w = readJSON(wf);
    if (!w?.publicKey) return console.log("Bad wallet file for --proof-nonce");

    const proof = chain.getNonceProof(w.publicKey);
    if (!proof) return console.log("No nonce proof available for that wallet");

    console.log(JSON.stringify(proof, null, 2));
    console.log(`verify=${verifyStateProof(proof)}`);
    return;
  }

  if (argHas(process.argv, "--proof-pending")) {
    const i = process.argv.indexOf("--proof-pending");
    const wf = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : walletFile;
    const idxStr = wf === walletFile ? process.argv[i + 1] : process.argv[i + 2];
    const pendingIdx = parseInt(idxStr || "0", 10);

    const w = readJSON(wf);
    if (!w?.publicKey) return console.log("Bad wallet file for --proof-pending");
    if (!Number.isFinite(pendingIdx) || pendingIdx < 0) return console.log("Bad pending index");

    const proof = chain.getPendingProof(w.publicKey, pendingIdx);
    if (!proof) return console.log("No pending proof available for that wallet/index");

    console.log(JSON.stringify(proof, null, 2));
    console.log(`verify=${verifyStateProof(proof)}`);
    return;
  }

  if (argHas(process.argv, "--proof-minted")) {
    const proof = chain.getMintedProof();
    if (!proof) return console.log("No minted proof available");

    console.log(JSON.stringify(proof, null, 2));
    console.log(`verify=${verifyStateProof(proof)}`);
    return;
  }

  if (argHas(process.argv, "--p2p-proof-minted")) {
    const peer = argValue(process.argv, "--p2p-proof-minted") || positionalPeerUrl;
    if (!peer) return console.log("Missing ws://peer for --p2p-proof-minted");

    const res = await requestP2PProof({
      peerUrl: peer,
      kind: "minted",
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (argHas(process.argv, "--p2p-proof-balance")) {
    const peer = argValue(process.argv, "--p2p-proof-balance") || positionalPeerUrl;
    if (!peer) return console.log("Missing ws://peer for --p2p-proof-balance");

    const walletArg = process.argv[process.argv.indexOf("--p2p-proof-balance") + 2] || walletFile;
    const w = readJSON(walletArg);
    if (!w?.publicKey) return console.log("Bad wallet file for --p2p-proof-balance");

    const res = await requestP2PProof({
      peerUrl: peer,
      kind: "balance",
      address: w.publicKey,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (argHas(process.argv, "--p2p-proof-nonce")) {
    const peer = argValue(process.argv, "--p2p-proof-nonce") || positionalPeerUrl;
    if (!peer) return console.log("Missing ws://peer for --p2p-proof-nonce");

    const walletArg = process.argv[process.argv.indexOf("--p2p-proof-nonce") + 2] || walletFile;
    const w = readJSON(walletArg);
    if (!w?.publicKey) return console.log("Bad wallet file for --p2p-proof-nonce");

    const res = await requestP2PProof({
      peerUrl: peer,
      kind: "nonce",
      address: w.publicKey,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (argHas(process.argv, "--p2p-proof-pending")) {
    const peer = argValue(process.argv, "--p2p-proof-pending") || positionalPeerUrl;
    if (!peer) return console.log("Missing ws://peer for --p2p-proof-pending");

    const i = process.argv.indexOf("--p2p-proof-pending");
    const walletArg =
      process.argv[i + 2] && !process.argv[i + 2].startsWith("--") ? process.argv[i + 2] : walletFile;
    const idxArg =
      walletArg === walletFile ? process.argv[i + 2] : process.argv[i + 3];
    const pendingIdx = parseInt(idxArg || "0", 10);

    const w = readJSON(walletArg);
    if (!w?.publicKey) return console.log("Bad wallet file for --p2p-proof-pending");
    if (!Number.isFinite(pendingIdx) || pendingIdx < 0) return console.log("Bad pending index");

    const res = await requestP2PProof({
      peerUrl: peer,
      kind: "pending",
      address: w.publicKey,
      pendingIndex: pendingIdx,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const automine = argHas(process.argv, "--automine");
  const mineEmpty = argHas(process.argv, "--mine-empty");
  const intervalMsRaw = parseInt(argValue(process.argv, "--mine-interval") || "15000", 10);
  const intervalMs = Number.isFinite(intervalMsRaw) ? Math.max(0, intervalMsRaw) : 15000;

  const yieldEveryRaw = parseInt(argValue(process.argv, "--mine-yield") || "20000", 10);
  const yieldEvery = Number.isFinite(yieldEveryRaw) ? Math.max(1000, yieldEveryRaw) : 20000;

  miningRuntime.enabled = automine;
  miningRuntime.paused = false;
  miningRuntime.stopRequested = false;
  miningRuntime.controlState = automine ? "running" : "stopped";
  miningRuntime.mineEmpty = mineEmpty;
  miningRuntime.intervalMs = intervalMs;
  miningRuntime.yieldEvery = yieldEvery;

  if (automine) {
    console.log(
      `⛏️ Auto-miner ON | interval=${intervalMs}ms | mineEmpty=${mineEmpty} | mineYield=${yieldEvery}`
    );
  } else {
    console.log("⛏️ Miner ready but stopped | open /mining to start");
  }

  while (true) {
    if (!miningRuntime.enabled || miningRuntime.paused) {
      miningRuntime.active = false;
      await sleep(250);
      continue;
    }

    if (!miningRuntime.mineEmpty && chain.mempool.size === 0) {
      miningRuntime.active = false;
      await sleep(Math.max(250, miningRuntime.intervalMs));
      continue;
    }

    const blk = chain.buildBlock(miner.publicKey);

    miningRuntime.stopRequested = false;
    miningRuntime.active = true;
    miningRuntime.startedAt = Date.now();
    miningRuntime.currentHeight = chain.height() + 1;
    miningRuntime.difficulty = blk.difficulty;
    miningRuntime.nonce = blk.nonce;
    miningRuntime.attempts = 0;
    miningRuntime.hashRate = 0;
    miningRuntime.currentHash = blk.hash;

    const mined = await blk.mineAsync(
      miningRuntime.yieldEvery,
      (progress) => {
        miningRuntime.nonce = progress.nonce;
        miningRuntime.attempts = progress.attempts;
        miningRuntime.hashRate = progress.hashRate;
        miningRuntime.currentHash = progress.hash;
      },
      () =>
        miningRuntime.stopRequested ||
        !miningRuntime.enabled ||
        miningRuntime.paused
    );

    miningRuntime.active = false;

    if (!mined) {
      miningRuntime.hashRate = 0;

      console.log(
        miningRuntime.paused
          ? "⏸️ Current mining attempt cancelled for pause"
          : "⏹️ Current mining attempt cancelled"
      );

      await tick();
      continue;
    }

    const ok2 = chain.tryAddBlock(blk);

    if (ok2) {
      broadcastBlock(blk);

      const fees = blk.txs
        .slice(1)
        .reduce((sum, tx) => sum + tx.fee, 0);

      const subsidy = blk.txs[0].amount - fees;

      miningRuntime.blocksMined++;
      miningRuntime.totalSubsidy += subsidy;
      miningRuntime.totalFees += fees;
      const minedAt = Date.now();

      const miningRecord = {
        height: chain.height(),
        hash: blk.hash,
        nonce: blk.nonce,
        difficulty: blk.difficulty,
        txCount: blk.txs.length,
        subsidy,
        fees,
        totalReward: subsidy + fees,
        minedAt,
      };

      miningRuntime.lastBlock = {
        height: miningRecord.height,
        hash: miningRecord.hash,
        nonce: miningRecord.nonce,
        difficulty: miningRecord.difficulty,
        txCount: miningRecord.txCount,
        subsidy: miningRecord.subsidy,
        fees: miningRecord.fees,
        minedAt: miningRecord.minedAt,
      };

      miningRuntime.history.unshift(miningRecord);

      if (miningRuntime.history.length > 100) {
        miningRuntime.history.length = 100;
      }

      console.log(
        `⛏️ Mined block #${chain.height()} | diff=${blk.difficulty} | subsidy=${subsidy} | fees=${fees} | txs=${blk.txs.length} | stateRoot=${blk.stateRoot.slice(0, 16)}... | orphans=${chain.orphanCount()}`
      );

      console.log(`📦 Mempool now: ${chain.mempool.size}`);
    }

    if (miningRuntime.intervalMs > 0) {
      let remaining = miningRuntime.intervalMs;

      while (
        remaining > 0 &&
        miningRuntime.enabled &&
        !miningRuntime.paused
      ) {
        const wait = Math.min(250, remaining);
        await sleep(wait);
        remaining -= wait;
      }
    } else {
      await tick();
    }
  }
}

main().catch((e) => console.error("Fatal:", e));