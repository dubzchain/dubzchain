import * as http from "http";
import * as fs from "fs";
import { URL } from "url";
import {
  broadcastTx,
  getNetworkStats,
  getNetworkPeerStats,
  type NetworkPeerStats,
} from "./network";

import {
  createRpcAuthConfig,
  checkRpcAuth,
  getRpcAuthStats,
  rpcAuthHeaders,
} from "./rpc-auth";

import {
  getExplorerDeploymentConfig,
  getExplorerDeploymentStats,
  handleExplorerOptions,
  robotsTxt,
  writeExplorerHeaders,
} from "./explorer-deploy";

import {
  getActiveNetworkProfile,
  exportNetworkProfileJson,
  summarizeNetworkProfile,
} from "./mainnet-profile";

import {
  createTelemetryConfig,
  getTelemetryStats,
  recordTelemetryRequest,
  buildTelemetrySnapshot,
  buildTelemetryMetricsText,
} from "./telemetry";

export type RpcTxJson = {
  id: string;
  type: string;
  from: string | null;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  ts: number;
  signature: string | null;
};

export type RpcBlockJson = {
  prevHash: string;
  ts: number;
  nonce: number;
  difficulty: number;
  stateRoot: string;
  txs: RpcTxJson[];
  hash: string;
};

export type RpcWalletFile = {
  publicKey: string;
  privateKey: string;
  address?: string;
};

export type RpcSnapshotJson = {
  height: number;
  tipHash: string;
  stateRoot: string;
  minted: number;
  balances: Record<string, number>;
  nonces: Record<string, number>;
  pending: Record<string, Array<{ amount: number; unlockHeight: number }>>;
  createdAt?: number;
};

export type RpcSnapshotMetaJson = {
  height: number;
  tipHash: string;
  stateRoot: string;
  minted: number;
  balancesCount: number;
  noncesCount: number;
  pendingAccounts: number;
  pendingRewards: number;
  createdAt: number;
};

export type RpcStorageStats = {
  mode: "archival" | "pruned";
  pruningEnabled: boolean;
  archivalMode: boolean;
  retentionWindow: number;
  checkpointHeight: number;
  checkpointTipHash: string;
  hasCheckpoint: boolean;
  localBlocks: number;
  retainedTailBlocks: number;
  fullHeight: number;
  prunedBlockCountEstimate: number;
  tipHash: string;
};

export type RpcServerDeps = {
  port: number;
  minerWalletFile: string;
  rpcHost?: string;

  chainId: string;
  protocolVersion: number;
  maxSupply: number;
  minFee: number;

  chain: {
    height(): number;
    tipHash(): string;
    orphanCount(): number;
    mempool: Map<string, { toJSON(): RpcTxJson }>;
    blocks: Array<{
      hash: string;
      prevHash: string;
      ts: number;
      difficulty: number;
      nonce: number;
      stateRoot: string;
      txs: RpcTxJson[];
      toJSON(): RpcBlockJson;
    }>;
    exportHeaders(): any[];
    getState(): {
      minted: number;
      balances: Map<string, number>;
      nonces: Map<string, number>;
      pending: Map<string, Array<{ amount: number; unlockHeight: number }>>;
    };
    getSpendable(pubKey: string): number;
    getImmature(pubKey: string): number;
    getTotal(pubKey: string): number;
    confirmedNonce(pubKey: string): number;
    nextNonce(pubKey: string): number;
    addToMempool(tx: any): boolean;
    validateChain?(blocks: any[]): boolean;
    validateBlock?(block: any): boolean;
    getStorageStats?(): RpcStorageStats;

    getBalanceProof(pubKey: string): any | null;
    getNonceProof(pubKey: string): any | null;
    getPendingProof(pubKey: string, index: number): any | null;
    getMintedProof(): any | null;

    exportCheckpointSnapshot?(): RpcSnapshotJson | null;
  };

  Tx: {
    fromJSON(j: any): any;
  };

  shortAddress(pubKeyPem: string): string;
  resolveAddressToPublicKey(
    input: string
  ): { publicKey: string; via: string; walletFile?: string } | null;
  loadWalletFromFile(path: string): RpcWalletFile | null;
  readRequestBody(req: http.IncomingMessage, limitBytes?: number): Promise<string>;
  submitTxToLocalNode(port: number, tx: any): Promise<boolean>;
  blockRewardAtHeight(height: number): number;
  verifyStateProof(proof: any): boolean;
};

type ExplorerSendHistoryItem = {
  ts: number;
  fromWalletFile: string | null;
  fromAddress: string | null;
  toInput: string | null;
  toAddress: string | null;
  amount: number | null;
  fee: number | null;
  txId: string | null;
  ok: boolean;
  submittedVia: string | null;
  error: string | null;
  heightAtSend: number | null;
  tipHashAtSend: string | null;
  mempoolSizeAfter: number | null;
};

type WalletResolvedInfo = {
  input: string;
  via: string;
  walletFile: string | null;
  address: string;
  publicKey: string;
  spendable: number;
  immature: number;
  total: number;
  confirmedNonce: number;
  nextNonce: number;
};

type WalletSendValidation = {
  ok: boolean;
  code?: string;
  error?: string;
  fromWalletFile: string;
  fromAddress?: string;
  toInput?: string;
  toAddress?: string;
  amount?: number;
  fee?: number;
  spendable?: number;
  immature?: number;
  total?: number;
  totalCost?: number;
  confirmedNonce?: number;
  nextNonce?: number;
  minFee?: number;
  note?: string;
};

type WalletLookupSummary = {
  ok: boolean;
  input: string;
  found: boolean;
  wallet?: WalletResolvedInfo;
  similarWalletFiles?: string[];
  error?: string;
};

const SEND_HISTORY_MAX = 40;
const FORK_COMPARE_BODY_LIMIT = 8_000_000;
const explorerSendHistory: ExplorerSendHistoryItem[] = [];

function getSendHistoryFile(port: number) {
  return `rpc.send-history.${port}.json`;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function jsonSend(res: http.ServerResponse, status: number, obj: any) {
  const body = JSON.stringify(obj, null, 2);
  writeExplorerHeaders(res, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  res.statusCode = status;
  res.end(body);
}

function textSend(
  res: http.ServerResponse,
  status: number,
  text: string,
  contentType = "text/plain; charset=utf-8"
) {
  writeExplorerHeaders(res, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text, "utf8"),
  });
  res.statusCode = status;
  res.end(text);
}

function htmlSend(res: http.ServerResponse, status: number, html: string) {
  writeExplorerHeaders(res, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html, "utf8"),
  });
  res.statusCode = status;
  res.end(html);
}

function safeDecodeURIComponent(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function htmlEscape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTs(ms: number) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function shortHash(h: string, n = 12) {
  return h.length <= n ? h : h.slice(0, n) + "...";
}

function shortKey(shortAddress: (pubKeyPem: string) => string, k: string) {
  return shortAddress(k);
}

function fmtNumber(n: number) {
  try {
    return new Intl.NumberFormat("en-US").format(n);
  } catch {
    return String(n);
  }
}

function fmtBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function mapNumToObj(m: Map<string, number>) {
  const out: Record<string, number> = {};
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

function pendingMapToObj(m: Map<string, Array<{ amount: number; unlockHeight: number }>>) {
  const out: Record<string, Array<{ amount: number; unlockHeight: number }>> = {};
  for (const [k, arr] of m.entries()) {
    out[k] = arr.map((x) => ({ amount: x.amount, unlockHeight: x.unlockHeight }));
  }
  return out;
}

function listWalletFiles() {
  try {
    return fs.readdirSync(".").filter((f) => /^wallet\..+\.json$/.test(f)).sort();
  } catch {
    return [];
  }
}

function isValidSendHistoryItem(x: any): x is ExplorerSendHistoryItem {
  return (
    x &&
    typeof x === "object" &&
    typeof x.ts === "number" &&
    "fromWalletFile" in x &&
    "fromAddress" in x &&
    "toInput" in x &&
    "toAddress" in x &&
    "amount" in x &&
    "fee" in x &&
    "txId" in x &&
    typeof x.ok === "boolean" &&
    "submittedVia" in x &&
    "error" in x &&
    "heightAtSend" in x &&
    "tipHashAtSend" in x &&
    "mempoolSizeAfter" in x
  );
}

function saveSendHistory(historyFile: string) {
  try {
    fs.writeFileSync(historyFile, JSON.stringify(explorerSendHistory, null, 2), "utf8");
  } catch (e: any) {
    console.log(`⚠️ send history save failed ${historyFile}: ${e?.message ?? String(e)}`);
  }
}

function loadSendHistory(historyFile: string) {
  try {
    if (!fs.existsSync(historyFile)) return;
    const raw = fs.readFileSync(historyFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    const clean = parsed.filter(isValidSendHistoryItem).slice(0, SEND_HISTORY_MAX);
    explorerSendHistory.length = 0;
    for (const item of clean) explorerSendHistory.push(item);

    console.log(`🧾 send history loaded ${historyFile} (items=${explorerSendHistory.length})`);
  } catch (e: any) {
    console.log(`⚠️ send history load failed ${historyFile}: ${e?.message ?? String(e)}`);
  }
}

function pushSendHistory(item: ExplorerSendHistoryItem, historyFile: string) {
  explorerSendHistory.unshift(item);
  while (explorerSendHistory.length > SEND_HISTORY_MAX) {
    explorerSendHistory.pop();
  }
  saveSendHistory(historyFile);
}

function clearSendHistory(historyFile: string) {
  explorerSendHistory.length = 0;
  try {
    fs.writeFileSync(historyFile, JSON.stringify([], null, 2), "utf8");
  } catch (e: any) {
    console.log(`⚠️ send history clear failed ${historyFile}: ${e?.message ?? String(e)}`);
  }
}

function buildLiveSnapshot(deps: RpcServerDeps): RpcSnapshotJson {
  if (typeof deps.chain.exportCheckpointSnapshot === "function") {
    const exported = deps.chain.exportCheckpointSnapshot();
    if (exported) return exported;
  }

  const st = deps.chain.getState();
  const tip = deps.chain.blocks[deps.chain.blocks.length - 1];
  return {
    height: deps.chain.height(),
    tipHash: tip.hash,
    stateRoot: tip.stateRoot,
    minted: st.minted,
    balances: mapNumToObj(st.balances),
    nonces: mapNumToObj(st.nonces),
    pending: pendingMapToObj(st.pending),
    createdAt: Date.now(),
  };
}

function buildLiveSnapshotMeta(deps: RpcServerDeps): RpcSnapshotMetaJson {
  const snap = buildLiveSnapshot(deps);
  const pendingAccounts = Object.keys(snap.pending).length;
  let pendingRewards = 0;
  for (const arr of Object.values(snap.pending)) pendingRewards += arr.length;

  return {
    height: snap.height,
    tipHash: snap.tipHash,
    stateRoot: snap.stateRoot,
    minted: snap.minted,
    balancesCount: Object.keys(snap.balances).length,
    noncesCount: Object.keys(snap.nonces).length,
    pendingAccounts,
    pendingRewards,
    createdAt: snap.createdAt ?? Date.now(),
  };
}

function getFallbackStorageStats(deps: RpcServerDeps): RpcStorageStats {
  const localBlocks = deps.chain.blocks.length;
  const fullHeight = deps.chain.height();
  const tipHash = deps.chain.tipHash();
  return {
    mode: "archival",
    pruningEnabled: false,
    archivalMode: true,
    retentionWindow: 0,
    checkpointHeight: 0,
    checkpointTipHash: deps.chain.blocks[0]?.hash ?? tipHash,
    hasCheckpoint: false,
    localBlocks,
    retainedTailBlocks: Math.max(0, localBlocks - 1),
    fullHeight,
    prunedBlockCountEstimate: 0,
    tipHash,
  };
}

function getStorageStatsSafe(deps: RpcServerDeps): RpcStorageStats {
  try {
    if (typeof deps.chain.getStorageStats === "function") {
      const out = deps.chain.getStorageStats();
      if (out && typeof out === "object") return out;
    }
  } catch {}
  return getFallbackStorageStats(deps);
}

function validatePrefixThroughHeight(deps: RpcServerDeps, height: number) {
  if (!Number.isFinite(height) || height < 0 || height >= deps.chain.blocks.length) {
    return {
      ok: false,
      error: "bad height",
      height,
    };
  }

  if (typeof deps.chain.validateChain !== "function") {
    return {
      ok: false,
      error: "validateChain not available",
      height,
    };
  }

  const prefix = deps.chain.blocks.slice(0, height + 1);
  const valid = deps.chain.validateChain(prefix as any[]);

  return {
    ok: true,
    height,
    prefixLength: prefix.length,
    valid,
    blockHash: deps.chain.blocks[height].hash,
    blockStateRoot: deps.chain.blocks[height].stateRoot,
    tipHeightNow: deps.chain.height(),
  };
}

function buildReplayVerify(deps: RpcServerDeps) {
  if (typeof deps.chain.validateChain !== "function") {
    return {
      ok: false,
      error: "validateChain not available",
    };
  }

  const valid = deps.chain.validateChain(deps.chain.blocks as any[]);
  return {
    ok: true,
    valid,
    height: deps.chain.height(),
    blockCount: deps.chain.blocks.length,
    tipHash: deps.chain.tipHash(),
  };
}

function buildBlockValidate(deps: RpcServerDeps, height: number) {
  const prefixCheck = validatePrefixThroughHeight(deps, height);
  if (!prefixCheck.ok) return prefixCheck;

  const block = deps.chain.blocks[height];
  const isTip = height === deps.chain.height();
  let tipLocalValidate: boolean | null = null;

  if (isTip && typeof deps.chain.validateBlock === "function") {
    try {
      tipLocalValidate = deps.chain.validateBlock(block as any);
    } catch {
      tipLocalValidate = null;
    }
  }

  return {
    ok: true,
    height,
    validPrefixThroughHeight: prefixCheck.valid,
    blockHash: block.hash,
    prevHash: block.prevHash,
    difficulty: block.difficulty,
    ts: block.ts,
    txCount: block.txs.length,
    stateRoot: block.stateRoot,
    isCurrentTip: isTip,
    tipLocalValidate,
  };
}

function buildStateRootCheck(deps: RpcServerDeps, height: number) {
  const prefixCheck = validatePrefixThroughHeight(deps, height);
  if (!prefixCheck.ok) return prefixCheck;

  const block = deps.chain.blocks[height];
  return {
    ok: true,
    height,
    validPrefixThroughHeight: prefixCheck.valid,
    stateRootAtHeight: block.stateRoot,
    hashAtHeight: block.hash,
    replayConsistent: prefixCheck.valid,
    note: prefixCheck.valid
      ? "Prefix replay through this height is valid."
      : "Prefix replay through this height failed, so state-root consistency failed too.",
  };
}

function workForDifficulty(diff: number): bigint {
  const safe = Math.max(0, Math.floor(Number.isFinite(diff) ? diff : 0));
  return 1n << BigInt(4 * safe);
}

function cumulativeWorkFromBlocks(blocks: Array<{ difficulty: number }>): bigint {
  let work = 0n;
  for (let i = 1; i < blocks.length; i++) {
    work += workForDifficulty(blocks[i].difficulty);
  }
  return work;
}

function findCommonHeightByHash(
  localBlocks: Array<{ hash: string }>,
  candidateBlocks: Array<{ hash: string }>
): number {
  const localIndexByHash = new Map<string, number>();
  for (let i = 0; i < localBlocks.length; i++) {
    localIndexByHash.set(localBlocks[i].hash, i);
  }

  let best = -1;
  for (let i = 0; i < candidateBlocks.length; i++) {
    const localIdx = localIndexByHash.get(candidateBlocks[i].hash);
    if (localIdx !== undefined && localIdx === i) {
      best = i;
      continue;
    }
    if (localIdx !== undefined) {
      best = Math.max(best, Math.min(localIdx, i));
    }
  }
  return best;
}

function buildForkCompareSummary(deps: RpcServerDeps) {
  const localBlocks = deps.chain.blocks;
  const localWork = cumulativeWorkFromBlocks(localBlocks);
  return {
    ok: true,
    local: {
      height: deps.chain.height(),
      blockCount: localBlocks.length,
      tipHash: deps.chain.tipHash(),
      cumulativeWork: localWork.toString(),
      storage: getStorageStatsSafe(deps),
    },
    usage: {
      method: "POST",
      path: "/debug/fork-compare",
      bodyShape: {
        blocks: "array of block json objects",
      },
      maxBodyBytes: FORK_COMPARE_BODY_LIMIT,
      note: "Post a candidate chain block array to compare local chain vs candidate by work, tip, and common height.",
    },
  };
}

function buildForkCompareAgainstCandidate(deps: RpcServerDeps, candidateRaw: any) {
  const candidateBlocks = Array.isArray(candidateRaw?.blocks)
    ? candidateRaw.blocks
    : Array.isArray(candidateRaw)
    ? candidateRaw
    : null;

  if (!candidateBlocks || candidateBlocks.length === 0) {
    return {
      ok: false,
      error: "missing candidate blocks",
    };
  }

  const hasValidShape = candidateBlocks.every((b: any) => {
    return (
      b &&
      typeof b === "object" &&
      typeof b.hash === "string" &&
      typeof b.prevHash === "string" &&
      typeof b.ts === "number" &&
      typeof b.nonce === "number" &&
      typeof b.difficulty === "number" &&
      typeof b.stateRoot === "string" &&
      Array.isArray(b.txs)
    );
  });

  if (!hasValidShape) {
    return {
      ok: false,
      error: "candidate blocks bad shape",
    };
  }

  const localBlocks = deps.chain.blocks;
  const localWork = cumulativeWorkFromBlocks(localBlocks);

  const candidateWork = cumulativeWorkFromBlocks(
    candidateBlocks.map((b: any) => ({
      difficulty: b.difficulty,
    }))
  );

  const commonHeight = findCommonHeightByHash(
    localBlocks.map((b) => ({ hash: b.hash })),
    candidateBlocks.map((b: any) => ({ hash: String(b?.hash ?? "") }))
  );

  const localTipHash = deps.chain.tipHash();
  const candidateTipHash =
    candidateBlocks.length > 0 && candidateBlocks[candidateBlocks.length - 1]
      ? String(candidateBlocks[candidateBlocks.length - 1].hash ?? "")
      : "";

  let preferred: "local" | "candidate" | "equal" = "equal";
  if (candidateWork > localWork) preferred = "candidate";
  else if (candidateWork < localWork) preferred = "local";

  return {
    ok: true,
    commonHeight,
    local: {
      height: deps.chain.height(),
      blockCount: localBlocks.length,
      tipHash: localTipHash,
      cumulativeWork: localWork.toString(),
    },
    candidate: {
      valid: true,
      validShape: true,
      height: candidateBlocks.length - 1,
      blockCount: candidateBlocks.length,
      tipHash: candidateTipHash,
      cumulativeWork: candidateWork.toString(),
    },
    comparison: {
      sameTip: candidateTipHash === localTipHash,
      sameHeight: candidateBlocks.length - 1 === deps.chain.height(),
      workDelta: (candidateWork - localWork).toString(),
      preferred,
      adoptCandidateByWork: candidateWork > localWork,
    },
    note: "Candidate was compared as posted block JSON by shape/hash/work. Full replay validation was not run here.",
  };
}

function resolveWalletInfo(deps: RpcServerDeps, input: string): WalletResolvedInfo | null {
  const resolved = deps.resolveAddressToPublicKey(input);
  if (!resolved) return null;

  return {
    input,
    via: resolved.via,
    walletFile: resolved.walletFile ?? null,
    address: deps.shortAddress(resolved.publicKey),
    publicKey: resolved.publicKey,
    spendable: deps.chain.getSpendable(resolved.publicKey),
    immature: deps.chain.getImmature(resolved.publicKey),
    total: deps.chain.getTotal(resolved.publicKey),
    confirmedNonce: deps.chain.confirmedNonce(resolved.publicKey),
    nextNonce: deps.chain.nextNonce(resolved.publicKey),
  };
}

function findSimilarWalletFiles(input: string) {
  const q = String(input || "").trim().toLowerCase();
  if (!q) return [] as string[];

  return listWalletFiles()
    .filter((f) => f.toLowerCase().includes(q))
    .slice(0, 8);
}

function buildWalletLookupSummary(deps: RpcServerDeps, inputRaw: string): WalletLookupSummary {
  const input = String(inputRaw || "").trim();

  if (!input) {
    return {
      ok: false,
      input,
      found: false,
      error: "missing input",
      similarWalletFiles: [],
    };
  }

  const wallet = resolveWalletInfo(deps, input);
  if (wallet) {
    return {
      ok: true,
      input,
      found: true,
      wallet,
      similarWalletFiles: wallet.walletFile ? [wallet.walletFile] : [],
    };
  }

  return {
    ok: false,
    input,
    found: false,
    error: "wallet/address not found",
    similarWalletFiles: findSimilarWalletFiles(input),
  };
}

function parseStrictInt(value: any): number | null {
  if (typeof value === "number" && Number.isFinite(value) && Math.floor(value) === value) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n) && Math.floor(n) === n) return n;
  }
  return null;
}

function validateWalletSendInputs(deps: RpcServerDeps, parsed: any): WalletSendValidation {
  const fromWalletFile = String(parsed?.fromWalletFile || deps.minerWalletFile);
  const toInputRaw = parsed?.to;
  const amount = parseStrictInt(parsed?.amount);
  const feeParsed =
    parsed?.fee === undefined || parsed?.fee === null || parsed?.fee === ""
      ? deps.minFee
      : parseStrictInt(parsed?.fee);

  if (!toInputRaw || !String(toInputRaw).trim()) {
    return {
      ok: false,
      code: "missing_to",
      error: "missing to",
      fromWalletFile,
      minFee: deps.minFee,
    };
  }

  const toInput = String(toInputRaw).trim();

  if (amount === null || amount <= 0) {
    return {
      ok: false,
      code: "bad_amount",
      error: "bad amount",
      fromWalletFile,
      toInput,
      fee: feeParsed === null ? undefined : feeParsed,
      minFee: deps.minFee,
    };
  }

  if (feeParsed === null || feeParsed < deps.minFee) {
    return {
      ok: false,
      code: "bad_fee",
      error: "bad fee",
      fromWalletFile,
      toInput,
      amount,
      minFee: deps.minFee,
    };
  }

  const fromWallet = deps.loadWalletFromFile(fromWalletFile);
  if (!fromWallet) {
    return {
      ok: false,
      code: "from_wallet_not_found",
      error: "from wallet not found",
      fromWalletFile,
      toInput,
      amount,
      fee: feeParsed,
      minFee: deps.minFee,
    };
  }

  const toResolved = deps.resolveAddressToPublicKey(toInput);
  if (!toResolved) {
    return {
      ok: false,
      code: "to_wallet_not_found",
      error: "to wallet/address not found",
      fromWalletFile,
      fromAddress: deps.shortAddress(fromWallet.publicKey),
      toInput,
      amount,
      fee: feeParsed,
      spendable: deps.chain.getSpendable(fromWallet.publicKey),
      immature: deps.chain.getImmature(fromWallet.publicKey),
      total: deps.chain.getTotal(fromWallet.publicKey),
      confirmedNonce: deps.chain.confirmedNonce(fromWallet.publicKey),
      nextNonce: deps.chain.nextNonce(fromWallet.publicKey),
      minFee: deps.minFee,
    };
  }

  const spendable = deps.chain.getSpendable(fromWallet.publicKey);
  const immature = deps.chain.getImmature(fromWallet.publicKey);
  const total = deps.chain.getTotal(fromWallet.publicKey);
  const totalCost = amount + feeParsed;
  const confirmedNonce = deps.chain.confirmedNonce(fromWallet.publicKey);
  const nextNonce = deps.chain.nextNonce(fromWallet.publicKey);

  if (spendable < totalCost) {
    return {
      ok: false,
      code: "insufficient_funds",
      error: "insufficient spendable funds",
      fromWalletFile,
      fromAddress: deps.shortAddress(fromWallet.publicKey),
      toInput,
      toAddress: deps.shortAddress(toResolved.publicKey),
      amount,
      fee: feeParsed,
      spendable,
      immature,
      total,
      totalCost,
      confirmedNonce,
      nextNonce,
      minFee: deps.minFee,
      note: "Spendable balance must cover amount + fee.",
    };
  }

  return {
    ok: true,
    fromWalletFile,
    fromAddress: deps.shortAddress(fromWallet.publicKey),
    toInput,
    toAddress: deps.shortAddress(toResolved.publicKey),
    amount,
    fee: feeParsed,
    spendable,
    immature,
    total,
    totalCost,
    confirmedNonce,
    nextNonce,
    minFee: deps.minFee,
  };
}

function buildDiagnostics(
  deps: RpcServerDeps,
  rpcHost: string,
  rpcPort: number,
  startedAtMs: number
) {
  const chain = deps.chain;
  const st = chain.getState();
  const tip = chain.blocks[chain.blocks.length - 1];
  const mem = process.memoryUsage();
  const network = getNetworkStats();
  const storage = getStorageStatsSafe(deps);
  const activeNetworkProfile = getActiveNetworkProfile(process.argv);
  const networkProfile = exportNetworkProfileJson(activeNetworkProfile);

  let pendingRewards = 0;
  for (const arr of st.pending.values()) pendingRewards += arr.length;

  const recentBlocks = chain.blocks.slice(Math.max(0, chain.blocks.length - 10));
  const blockIntervals: number[] = [];
  for (let i = 1; i < recentBlocks.length; i++) {
    blockIntervals.push(recentBlocks[i].ts - recentBlocks[i - 1].ts);
  }

  const avgBlockMs =
    blockIntervals.length > 0
      ? Math.round(blockIntervals.reduce((a, b) => a + b, 0) / blockIntervals.length)
      : null;

  const walletFiles = listWalletFiles();

  return {
    ok: true,
    node: {
      chainId: deps.chainId,
      protocolVersion: deps.protocolVersion,
      p2pPort: deps.port,
      rpcHost,
      rpcPort,
      startedAt: startedAtMs,
      startedAtIso: new Date(startedAtMs).toISOString(),
      uptimeMs: Date.now() - startedAtMs,
      uptimeHuman: fmtDuration(Date.now() - startedAtMs),
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version,
      cwd: process.cwd(),
    },
    chain: {
      height: chain.height(),
      tipHash: tip.hash,
      prevHash: tip.prevHash,
      tipTs: tip.ts,
      tipTsHuman: fmtTs(tip.ts),
      tipDifficulty: tip.difficulty,
      tipStateRoot: tip.stateRoot,
      tipTxCount: tip.txs.length,
      headers: chain.exportHeaders().length,
      blocksLoaded: chain.blocks.length,
      mempoolSize: chain.mempool.size,
      orphanCount: chain.orphanCount(),
      minted: st.minted,
      maxSupply: deps.maxSupply,
      remainingSupply: Math.max(0, deps.maxSupply - st.minted),
      supplyPct: deps.maxSupply > 0 ? Number(((st.minted / deps.maxSupply) * 100).toFixed(6)) : 0,
      rewardNow: deps.blockRewardAtHeight(chain.height() + 1),
      balancesTracked: st.balances.size,
      noncesTracked: st.nonces.size,
      pendingAccounts: st.pending.size,
      pendingRewards,
      avgRecentBlockMs: avgBlockMs,
      avgRecentBlockSeconds: avgBlockMs === null ? null : Number((avgBlockMs / 1000).toFixed(3)),
      cumulativeWork: cumulativeWorkFromBlocks(chain.blocks).toString(),
    },
    networkProfile,
    network,
    rpcAuth: getRpcAuthStats(),
    explorerDeployment: getExplorerDeploymentStats(),
    telemetry: buildTelemetrySnapshot({
      node: {
        chainId: deps.chainId,
        protocolVersion: deps.protocolVersion,
        p2pPort: deps.port,
        rpcHost,
        rpcPort,
        startedAt: startedAtMs,
        uptimeMs: Date.now() - startedAtMs,
      },
      chain: {
        height: chain.height(),
        tipHash: tip.hash,
        mempoolSize: chain.mempool.size,
        orphanCount: chain.orphanCount(),
        minted: st.minted,
        rewardNow: deps.blockRewardAtHeight(chain.height() + 1),
        cumulativeWork: cumulativeWorkFromBlocks(chain.blocks).toString(),
      },
      network,
      storage,
      process: {
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
      },
      rpcAuth: getRpcAuthStats(),
      explorerDeployment: getExplorerDeploymentStats(),
    }).telemetry,
    storage,
    process: {
      rssBytes: mem.rss,
      heapTotalBytes: mem.heapTotal,
      heapUsedBytes: mem.heapUsed,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
      rssHuman: fmtBytes(mem.rss),
      heapTotalHuman: fmtBytes(mem.heapTotal),
      heapUsedHuman: fmtBytes(mem.heapUsed),
      externalHuman: fmtBytes(mem.external),
      arrayBuffersHuman: fmtBytes(mem.arrayBuffers),
    },
    files: {
      defaultMinerWalletFile: deps.minerWalletFile,
      discoveredWalletFiles: walletFiles,
      walletCount: walletFiles.length,
    },
    recent: {
      blocks: recentBlocks.map((b, idx) => {
        const height = chain.blocks.length - recentBlocks.length + idx;
        return {
          height,
          hash: b.hash,
          prevHash: b.prevHash,
          ts: b.ts,
          tsHuman: fmtTs(b.ts),
          difficulty: b.difficulty,
          txCount: b.txs.length,
          stateRoot: b.stateRoot,
        };
      }),
      mempool: Array.from(chain.mempool.values())
        .slice(0, 25)
        .map((t) => t.toJSON()),
    },
    explorerSendHistory: explorerSendHistory.slice(0, 20),
  };
}

function buildMetricsText(
  deps: RpcServerDeps,
  rpcHost: string,
  rpcPort: number,
  startedAtMs: number
) {
  const chain = deps.chain;
  const st = chain.getState();
  const tip = chain.blocks[chain.blocks.length - 1];
  const mem = process.memoryUsage();
  const network = getNetworkStats();
  const storage = getStorageStatsSafe(deps);
  const activeNetworkProfile = getActiveNetworkProfile(process.argv);
  const networkProfile = exportNetworkProfileJson(activeNetworkProfile);

  let pendingRewards = 0;
  for (const arr of st.pending.values()) pendingRewards += arr.length;

  const recentBlocks = chain.blocks.slice(Math.max(0, chain.blocks.length - 10));
  const blockIntervals: number[] = [];
  for (let i = 1; i < recentBlocks.length; i++) {
    blockIntervals.push(recentBlocks[i].ts - recentBlocks[i - 1].ts);
  }
  const avgBlockMs =
    blockIntervals.length > 0
      ? Math.round(blockIntervals.reduce((a, b) => a + b, 0) / blockIntervals.length)
      : 0;

  const lines = [
    "# DubzChain metrics",
    `dubzchain_rpc_up 1`,
    `dubzchain_p2p_port ${deps.port}`,
    `dubzchain_rpc_port ${rpcPort}`,
    `dubzchain_protocol_version ${deps.protocolVersion}`,
    `dubzchain_height ${chain.height()}`,
    `dubzchain_mempool_size ${chain.mempool.size}`,
    `dubzchain_orphan_count ${chain.orphanCount()}`,
    `dubzchain_minted_supply ${st.minted}`,
    `dubzchain_max_supply ${deps.maxSupply}`,
    `dubzchain_remaining_supply ${Math.max(0, deps.maxSupply - st.minted)}`,
    `dubzchain_reward_now ${deps.blockRewardAtHeight(chain.height() + 1)}`,
    `dubzchain_tip_difficulty ${tip.difficulty}`,
    `dubzchain_tip_tx_count ${tip.txs.length}`,
    `dubzchain_balances_tracked ${st.balances.size}`,
    `dubzchain_nonces_tracked ${st.nonces.size}`,
    `dubzchain_pending_accounts ${st.pending.size}`,
    `dubzchain_pending_rewards ${pendingRewards}`,
    `dubzchain_avg_recent_block_ms ${avgBlockMs}`,
    `dubzchain_uptime_ms ${Date.now() - startedAtMs}`,
    `dubzchain_process_pid ${process.pid}`,
    `dubzchain_process_rss_bytes ${mem.rss}`,
    `dubzchain_process_heap_total_bytes ${mem.heapTotal}`,
    `dubzchain_process_heap_used_bytes ${mem.heapUsed}`,
    `dubzchain_process_external_bytes ${mem.external}`,
    `dubzchain_process_arraybuffers_bytes ${mem.arrayBuffers}`,
    `dubzchain_tip_timestamp_ms ${tip.ts}`,
    `dubzchain_started_at_ms ${startedAtMs}`,
    `dubzchain_rpc_host_info "${rpcHost}"`,
    `dubzchain_chain_id_info "${deps.chainId}"`,
    `dubzchain_tip_hash_info "${tip.hash}"`,
    `dubzchain_tip_state_root_info "${tip.stateRoot}"`,
    `dubzchain_chain_work "${cumulativeWorkFromBlocks(chain.blocks).toString()}"`,
    `dubzchain_p2p_open_sockets ${network.socketsOpen}`,
    `dubzchain_p2p_inbound_open ${network.inboundOpen}`,
    `dubzchain_p2p_outbound_open ${network.outboundOpen}`,
    `dubzchain_known_peers ${network.knownPeers}`,
    `dubzchain_peer_table_size ${network.peerTableSize}`,
    `dubzchain_reconnect_scheduled ${network.reconnectScheduled}`,
    `dubzchain_banned_ips ${network.bannedIps}`,
    `dubzchain_sync_best_remote_height ${network.sync.bestRemoteHeight}`,
    `dubzchain_sync_target_height ${network.sync.syncTargetHeight}`,
    `dubzchain_sync_lag_blocks ${network.sync.lagBlocks}`,
    `dubzchain_sync_progress_pct ${network.sync.syncProgressPct}`,
    `dubzchain_messages_received ${network.traffic.messagesReceived}`,
    `dubzchain_messages_sent ${network.traffic.messagesSent}`,
    `dubzchain_bytes_received_approx ${network.traffic.bytesReceivedApprox}`,
    `dubzchain_bytes_sent_approx ${network.traffic.bytesSentApprox}`,
    `dubzchain_compressed_messages_received ${network.traffic.compressedMessagesReceived}`,
    `dubzchain_compressed_messages_sent ${network.traffic.compressedMessagesSent}`,
    `dubzchain_snapshot_meta_requests_sent ${network.counters.snapshotMetaRequestsSent}`,
    `dubzchain_snapshot_meta_responses_received ${network.counters.snapshotMetaResponsesReceived}`,
    `dubzchain_snapshot_requests_sent ${network.counters.snapshotRequestsSent}`,
    `dubzchain_snapshot_responses_received ${network.counters.snapshotResponsesReceived}`,
    `dubzchain_snapshot_imports_succeeded ${network.counters.snapshotImportsSucceeded}`,
    `dubzchain_snapshot_imports_failed ${network.counters.snapshotImportsFailed}`,
    `dubzchain_compact_received ${network.counters.compactReceived}`,
    `dubzchain_compact_accepted ${network.counters.compactAccepted}`,
    `dubzchain_compact_rejected ${network.counters.compactRejected}`,
    `dubzchain_compact_stalled ${network.counters.compactStalled}`,
    `dubzchain_full_block_received ${network.counters.fullBlockReceived}`,
    `dubzchain_full_block_accepted ${network.counters.fullBlockAccepted}`,
    `dubzchain_full_block_rejected ${network.counters.fullBlockRejected}`,
    `dubzchain_orphan_stored ${network.counters.orphanStored}`,
    `dubzchain_orphan_resolved_approx ${network.counters.orphanResolvedApprox}`,
    `dubzchain_storage_pruning_enabled ${storage.pruningEnabled ? 1 : 0}`,
    `dubzchain_storage_archival_mode ${storage.archivalMode ? 1 : 0}`,
    `dubzchain_storage_retention_window ${storage.retentionWindow}`,
    `dubzchain_storage_checkpoint_height ${storage.checkpointHeight}`,
    `dubzchain_storage_local_blocks ${storage.localBlocks}`,
    `dubzchain_storage_retained_tail_blocks ${storage.retainedTailBlocks}`,
    `dubzchain_storage_full_height ${storage.fullHeight}`,
    `dubzchain_storage_pruned_block_estimate ${storage.prunedBlockCountEstimate}`,
  ];

  return lines.join("\n") + "\n";
}

function renderPeerRows(peers: NetworkPeerStats[]) {
  if (!peers.length) {
    return `<tr><td colspan="9" class="muted">No connected peers</td></tr>`;
  }

  return peers
    .map((p) => {
      return `
        <tr>
          <td>${htmlEscape(p.peer)}</td>
          <td>${htmlEscape(p.direction)}</td>
          <td>${htmlEscape(p.readyStateLabel)}</td>
          <td>${p.remoteHeight ?? "-"}</td>
          <td>${p.latencyMs ?? "-"}</td>
          <td>${p.idleMs ?? "-"}</td>
          <td>${p.connectedForMs ?? "-"}</td>
          <td>${p.remoteTipHash ? htmlEscape(shortHash(p.remoteTipHash, 18)) : "-"}</td>
          <td>${htmlEscape(p.url ?? p.ip)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderExplorerHtml(deps: RpcServerDeps, rpcPort: number, startedAtMs: number) {
  const chain = deps.chain;
  const state = chain.getState();
  const tip = chain.blocks[chain.blocks.length - 1];
  const recentBlocks = chain.blocks.slice(Math.max(0, chain.blocks.length - 20)).reverse();
  const mempoolTxs = Array.from(chain.mempool.values()).slice(0, 50);
  const mem = process.memoryUsage();
  const walletFiles = listWalletFiles();
  const network = getNetworkStats();
  const storage = getStorageStatsSafe(deps);
  const activeNetworkProfile = getActiveNetworkProfile(process.argv);
  const networkProfile = exportNetworkProfileJson(activeNetworkProfile);

  let pendingRewards = 0;
  for (const arr of state.pending.values()) pendingRewards += arr.length;

  const recentIntervals: number[] = [];
  const forwardRecent = chain.blocks.slice(Math.max(0, chain.blocks.length - 10));
  for (let i = 1; i < forwardRecent.length; i++) {
    recentIntervals.push(forwardRecent[i].ts - forwardRecent[i - 1].ts);
  }
  const avgBlockMs =
    recentIntervals.length > 0
      ? Math.round(recentIntervals.reduce((a, b) => a + b, 0) / recentIntervals.length)
      : null;

  const recentBlocksHtml = recentBlocks
    .map((b, i) => {
      const height = chain.blocks.length - 1 - i;
      return `
        <tr>
          <td>${height}</td>
          <td><a href="/index?height=${height}">${htmlEscape(shortHash(b.hash, 18))}</a></td>
          <td>${htmlEscape(shortHash(b.prevHash || "GENESIS", 18))}</td>
          <td>${b.difficulty}</td>
          <td>${b.txs.length}</td>
          <td>${htmlEscape(fmtTs(b.ts))}</td>
        </tr>
      `;
    })
    .join("");

  const mempoolHtml =
    mempoolTxs.length === 0
      ? `<tr><td colspan="6" class="muted">No mempool transactions</td></tr>`
      : mempoolTxs
          .map((t) => {
            const j = t.toJSON();
            return `
        <tr>
          <td><a href="/tx/${encodeURIComponent(j.id)}">${htmlEscape(shortHash(j.id, 18))}</a></td>
          <td>${htmlEscape(j.from ? shortKey(deps.shortAddress, j.from) : "null")}</td>
          <td>${htmlEscape(shortKey(deps.shortAddress, j.to))}</td>
          <td>${j.amount}</td>
          <td>${j.fee}</td>
          <td>${j.nonce}</td>
        </tr>
      `;
          })
          .join("");

  const defaultWallet = deps.loadWalletFromFile(deps.minerWalletFile);
  const defaultWalletAddress = defaultWallet ? deps.shortAddress(defaultWallet.publicKey) : "";
  const defaultWalletSpendable = defaultWallet ? chain.getSpendable(defaultWallet.publicKey) : 0;
  const defaultWalletImmature = defaultWallet ? chain.getImmature(defaultWallet.publicKey) : 0;
  const defaultWalletTotal = defaultWallet ? chain.getTotal(defaultWallet.publicKey) : 0;
  const defaultWalletNextNonce = defaultWallet ? chain.nextNonce(defaultWallet.publicKey) : 0;

  const walletOptionsHtml =
    walletFiles.length === 0
      ? `<option value="${htmlEscape(deps.minerWalletFile)}">${htmlEscape(deps.minerWalletFile)}</option>`
      : walletFiles
          .map((walletFile) => {
            const w = deps.loadWalletFromFile(walletFile);
            const labelParts = [walletFile];
            if (w?.publicKey) {
              labelParts.push(deps.shortAddress(w.publicKey));
              labelParts.push(`spendable=${chain.getSpendable(w.publicKey)}`);
            }
            const selected = walletFile === deps.minerWalletFile ? " selected" : "";
            return `<option value="${htmlEscape(walletFile)}"${selected}>${htmlEscape(labelParts.join(" | "))}</option>`;
          })
          .join("");

  const sendHistoryHtml =
    explorerSendHistory.length === 0
      ? `<tr><td colspan="10" class="muted">No explorer send history yet</td></tr>`
      : explorerSendHistory
          .slice(0, 12)
          .map((item) => {
            const status = item.ok ? "OK" : "FAIL";
            const statusClass = item.ok ? "ok" : "bad-text";
            return `
        <tr>
          <td>${htmlEscape(fmtTs(item.ts))}</td>
          <td class="${statusClass}">${htmlEscape(status)}</td>
          <td>${htmlEscape(item.submittedVia ?? "-")}</td>
          <td>${item.heightAtSend ?? "-"}</td>
          <td>${htmlEscape(item.fromAddress ?? item.fromWalletFile ?? "-")}</td>
          <td>${htmlEscape(item.toAddress ?? item.toInput ?? "-")}</td>
          <td>${item.amount ?? "-"}</td>
          <td>${item.fee ?? "-"}</td>
          <td>${item.txId ? `<a href="/tx/${encodeURIComponent(item.txId)}">${htmlEscape(shortHash(item.txId, 18))}</a>` : "-"}</td>
          <td>${item.error ? htmlEscape(item.error) : "-"}</td>
        </tr>
      `;
          })
          .join("");

  const peerRowsHtml = renderPeerRows(network.peers);
  const walletLookupDefaultValue = htmlEscape(deps.minerWalletFile);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DubzChain Explorer</title>
<style>
  :root{
    --bg:#0b1020;
    --panel:#121933;
    --line:#273156;
    --text:#e8ecff;
    --muted:#9aa6d1;
    --accent:#7aa2ff;
    --good:#38d39f;
    --bad:#ff6b81;
    --warn:#ffcf66;
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    background:radial-gradient(circle at top left,#18224a 0%,#0b1020 45%,#080c18 100%);
    color:var(--text);
    font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  }
  .wrap{max-width:1320px;margin:0 auto;padding:24px}
  h1,h2,h3{margin:0 0 12px}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .grid{
    display:grid;
    grid-template-columns:repeat(12,1fr);
    gap:16px;
  }
  .card{
    background:rgba(18,25,51,.92);
    border:1px solid var(--line);
    border-radius:18px;
    padding:18px;
    box-shadow:0 12px 40px rgba(0,0,0,.28);
  }
  .hero{grid-column:1 / -1}
  .stats{grid-column:1 / -1;display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
  .stat{
    background:rgba(10,16,32,.55);
    border:1px solid var(--line);
    border-radius:14px;
    padding:12px;
  }
  .stat .label{font-size:12px;color:var(--muted)}
  .stat .value{font-size:20px;font-weight:700;margin-top:4px}
  .half{grid-column:span 6}
  .full{grid-column:1 / -1}
  .third{grid-column:span 4}
  .muted{color:var(--muted)}
  .bad-text{color:var(--bad)}
  table{width:100%;border-collapse:collapse}
  th,td{
    padding:10px 8px;
    border-bottom:1px solid rgba(255,255,255,.08);
    text-align:left;
    vertical-align:top;
    word-break:break-word;
  }
  th{color:var(--muted);font-weight:600}
  .row{
    display:flex;
    gap:10px;
    flex-wrap:wrap;
    align-items:center;
  }
  .pill{
    display:inline-flex;
    align-items:center;
    gap:6px;
    padding:6px 10px;
    border:1px solid var(--line);
    border-radius:999px;
    color:var(--muted);
    background:rgba(10,16,32,.45);
  }
  .ok{color:var(--good)}
  .form{
    display:flex;
    gap:8px;
    flex-wrap:wrap;
    margin-top:10px;
  }
  .form input,
  .form select,
  .send-form input,
  .send-form select{
    flex:1 1 240px;
    min-width:220px;
    background:#0b1020;
    color:var(--text);
    border:1px solid var(--line);
    border-radius:12px;
    padding:10px 12px;
    outline:none;
  }
  .form button,
  .send-form button{
    background:var(--accent);
    color:#071022;
    border:0;
    border-radius:12px;
    padding:10px 14px;
    font-weight:700;
    cursor:pointer;
  }
  .form button:disabled,
  .send-form button:disabled{
    opacity:.65;
    cursor:not-allowed;
  }
  .send-form{
    display:grid;
    grid-template-columns:repeat(12,1fr);
    gap:12px;
  }
  .send-form .field{
    grid-column:span 6;
  }
  .send-form .field.full{
    grid-column:1 / -1;
  }
  .send-form .actions{
    grid-column:1 / -1;
    display:flex;
    gap:10px;
    flex-wrap:wrap;
    align-items:center;
  }
  .small{font-size:12px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
  .result{
    margin-top:14px;
    border:1px solid var(--line);
    border-radius:14px;
    padding:14px;
    background:rgba(10,16,32,.6);
  }
  .result.good{border-color:rgba(56,211,159,.45)}
  .result.bad{border-color:rgba(255,107,129,.45)}
  .result.warn{border-color:rgba(255,207,102,.45)}
  .result pre{
    margin:10px 0 0;
    white-space:pre-wrap;
    word-break:break-word;
    font-size:12px;
    line-height:1.45;
  }
  .hint{
    color:var(--muted);
    font-size:12px;
    margin-top:8px;
  }
  .badge{
    display:inline-flex;
    align-items:center;
    gap:6px;
    padding:4px 8px;
    border-radius:999px;
    border:1px solid var(--line);
    margin-right:8px;
    margin-top:8px;
  }
  .badge.good{
    color:var(--good);
    border-color:rgba(56,211,159,.4);
  }
  .badge.bad{
    color:var(--bad);
    border-color:rgba(255,107,129,.4);
  }
  .badge.warn{
    color:var(--warn);
    border-color:rgba(255,207,102,.4);
  }
  #historyMeta{
    display:inline-block;
    margin-left:4px;
  }
  @media (max-width:980px){
    .stats{grid-template-columns:repeat(2,1fr)}
    .half,.third{grid-column:1 / -1}
    .send-form .field{grid-column:1 / -1}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="grid">
    <section class="card hero">
      <div class="row">
        <h1>DubzChain Explorer</h1>
        <span class="pill ok">RPC ${rpcPort}</span>
        <span class="pill">P2P ${deps.port}</span>
        <span class="pill">${htmlEscape(deps.chainId)} v${deps.protocolVersion}</span>
        <span class="pill">Peers ${network.socketsOpen}</span>
        <span class="pill">Sync ${network.sync.syncProgressPct}%</span>
        <span class="pill">Storage ${htmlEscape(storage.mode)}</span>
      </div>
      <p class="muted">
        Live local explorer for node <strong>ws://localhost:${deps.port}</strong>.
        Default wallet file: <strong>${htmlEscape(deps.minerWalletFile)}</strong>.
      </p>
      <div class="form">
        <input id="heightInput" placeholder="Jump to block height (example: ${chain.height()})" />
        <button id="openBlockBtn" type="button">Open block</button>
      </div>
      <p class="small muted">Tip hash: ${htmlEscape(tip.hash)}</p>
    </section>

    <section class="stats full">
      <div class="stat"><div class="label">Height</div><div class="value">${fmtNumber(chain.height())}</div></div>
      <div class="stat"><div class="label">Mempool</div><div class="value">${fmtNumber(chain.mempool.size)}</div></div>
      <div class="stat"><div class="label">Orphans</div><div class="value">${fmtNumber(chain.orphanCount())}</div></div>
      <div class="stat"><div class="label">Minted</div><div class="value">${fmtNumber(state.minted)}</div></div>
      <div class="stat"><div class="label">Reward Now</div><div class="value">${fmtNumber(deps.blockRewardAtHeight(chain.height() + 1))}</div></div>
      <div class="stat"><div class="label">Tip Difficulty</div><div class="value">${fmtNumber(tip.difficulty)}</div></div>
    </section>

    <section class="card third">
      <h2>Runtime</h2>
      <table>
        <tbody>
          <tr><th>PID</th><td>${process.pid}</td></tr>
          <tr><th>Node</th><td>${htmlEscape(process.version)}</td></tr>
          <tr><th>Platform</th><td>${htmlEscape(process.platform)}</td></tr>
          <tr><th>Uptime</th><td>${htmlEscape(fmtDuration(Date.now() - startedAtMs))}</td></tr>
          <tr><th>RSS</th><td>${htmlEscape(fmtBytes(mem.rss))}</td></tr>
          <tr><th>Heap Used</th><td>${htmlEscape(fmtBytes(mem.heapUsed))}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card third">
      <h2>Observability</h2>
      <table>
        <tbody>
          <tr><th>Avg Recent Block Time</th><td>${avgBlockMs === null ? "n/a" : String(avgBlockMs) + " ms"}</td></tr>
          <tr><th>Balances Tracked</th><td>${fmtNumber(state.balances.size)}</td></tr>
          <tr><th>Nonces Tracked</th><td>${fmtNumber(state.nonces.size)}</td></tr>
          <tr><th>Pending Accounts</th><td>${fmtNumber(state.pending.size)}</td></tr>
          <tr><th>Pending Rewards</th><td>${fmtNumber(pendingRewards)}</td></tr>
          <tr><th>Supply Remaining</th><td>${fmtNumber(Math.max(0, deps.maxSupply - state.minted))}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card third">
      <h2>Quick Links</h2>
      <table>
        <tbody>
          <tr><th>Status</th><td><a href="/status">/status</a></td></tr>
          <tr><th>Diagnostics</th><td><a href="/diagnostics">/diagnostics</a></td></tr>
          <tr><th>Deployment</th><td><a href="/deployment">/deployment</a></td></tr>
          <tr><th>Metrics</th><td><a href="/metrics">/metrics</a></td></tr>
          <tr><th>Peers</th><td><a href="/peers">/peers</a></td></tr>
          <tr><th>Sync</th><td><a href="/sync">/sync</a></td></tr>
          <tr><th>Storage</th><td><a href="/storage">/storage</a></td></tr>
          <tr><th>Network</th><td><a href="/diagnostics/network">/diagnostics/network</a></td></tr>
          <tr><th>Replay Verify</th><td><a href="/debug/replay-verify">/debug/replay-verify</a></td></tr>
          <tr><th>Fork Compare</th><td><a href="/debug/fork-compare">/debug/fork-compare</a></td></tr>
          <tr><th>Wallet Resolve</th><td><a href="/wallet/resolve?input=${encodeURIComponent(deps.minerWalletFile)}">/wallet/resolve</a></td></tr>
          <tr><th>Wallet Lookup</th><td><a href="/wallet/lookup?input=${encodeURIComponent(deps.minerWalletFile)}">/wallet/lookup</a></td></tr>
          <tr><th>Wallet Send Validate</th><td><a href="/wallet/default">/wallet/default</a></td></tr>
          <tr><th>State Check</th><td><a href="/debug/state-root-check?height=${chain.height()}">/debug/state-root-check</a></td></tr>
          <tr><th>Block Validate</th><td><a href="/debug/block-validate?height=${chain.height()}">/debug/block-validate</a></td></tr>
          <tr><th>Debug State</th><td><a href="/debug/state">/debug/state</a></td></tr>
          <tr><th>Debug Runtime</th><td><a href="/debug/runtime">/debug/runtime</a></td></tr>
          <tr><th>Stats</th><td><a href="/stats">/stats</a></td></tr>
        </tbody>
      </table>
    </section>

    <section class="card half">
      <h2>Network Summary</h2>
      <table>
        <tbody>
          <tr><th>Open Peers</th><td>${network.socketsOpen}</td></tr>
          <tr><th>Inbound / Outbound</th><td>${network.inboundOpen} / ${network.outboundOpen}</td></tr>
          <tr><th>Known Peers</th><td>${network.knownPeers}</td></tr>
          <tr><th>Peer Table</th><td>${network.peerTableSize}</td></tr>
          <tr><th>Best Remote Height</th><td>${network.sync.bestRemoteHeight}</td></tr>
          <tr><th>Sync Target Height</th><td>${network.sync.syncTargetHeight}</td></tr>
          <tr><th>Sync Lag Blocks</th><td>${network.sync.lagBlocks}</td></tr>
          <tr><th>Sync Progress</th><td>${network.sync.syncProgressPct}%</td></tr>
          <tr><th>Snapshot Bootstrap</th><td>${htmlEscape(network.snapshotBootstrap.status)}</td></tr>
          <tr><th>Snapshot Peer</th><td>${htmlEscape(network.snapshotBootstrap.peer ?? "-")}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card half">
      <h2>Storage Summary</h2>
      <table>
        <tbody>
          <tr><th>Mode</th><td>${htmlEscape(storage.mode)}</td></tr>
          <tr><th>Pruning Enabled</th><td>${storage.pruningEnabled ? "true" : "false"}</td></tr>
          <tr><th>Archival Mode</th><td>${storage.archivalMode ? "true" : "false"}</td></tr>
          <tr><th>Retention Window</th><td>${storage.retentionWindow}</td></tr>
          <tr><th>Checkpoint Height</th><td>${storage.checkpointHeight}</td></tr>
          <tr><th>Has Checkpoint</th><td>${storage.hasCheckpoint ? "true" : "false"}</td></tr>
          <tr><th>Local Blocks</th><td>${storage.localBlocks}</td></tr>
          <tr><th>Retained Tail</th><td>${storage.retainedTailBlocks}</td></tr>
          <tr><th>Full Height</th><td>${storage.fullHeight}</td></tr>
          <tr><th>Pruned Estimate</th><td>${storage.prunedBlockCountEstimate}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card full">
      <h2>Connected Peers</h2>
      <table>
        <thead>
          <tr>
            <th>Peer</th>
            <th>Dir</th>
            <th>State</th>
            <th>Remote Height</th>
            <th>Latency ms</th>
            <th>Idle ms</th>
            <th>Connected ms</th>
            <th>Remote Tip</th>
            <th>URL / IP</th>
          </tr>
        </thead>
        <tbody>
          ${peerRowsHtml}
        </tbody>
      </table>
    </section>

    <section class="card full">
      <h2>Network Counters</h2>
      <table>
        <tbody>
          <tr><th>Messages Rx / Tx</th><td>${network.traffic.messagesReceived} / ${network.traffic.messagesSent}</td></tr>
          <tr><th>Bytes Rx / Tx</th><td>${fmtBytes(network.traffic.bytesReceivedApprox)} / ${fmtBytes(network.traffic.bytesSentApprox)}</td></tr>
          <tr><th>Compressed Rx / Tx</th><td>${network.traffic.compressedMessagesReceived} / ${network.traffic.compressedMessagesSent}</td></tr>
          <tr><th>Snapshot Imports OK / Fail</th><td>${network.counters.snapshotImportsSucceeded} / ${network.counters.snapshotImportsFailed}</td></tr>
          <tr><th>Compact Accepted / Rejected / Stalled</th><td>${network.counters.compactAccepted} / ${network.counters.compactRejected} / ${network.counters.compactStalled}</td></tr>
          <tr><th>Full Blocks Accepted / Rejected</th><td>${network.counters.fullBlockAccepted} / ${network.counters.fullBlockRejected}</td></tr>
          <tr><th>Orphan Stored / Resolved</th><td>${network.counters.orphanStored} / ${network.counters.orphanResolvedApprox}</td></tr>
          <tr><th>Reconnect Attempts / Scheduled</th><td>${network.counters.reconnectAttempts} / ${network.counters.reconnectScheduled}</td></tr>
          <tr><th>Rate Rejects / Bans</th><td>${network.counters.rateLimitRejects} / ${network.counters.bansIssued}</td></tr>
          <tr><th>Bad Messages</th><td>${network.counters.badMessages}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card full">
      <h2>Wallet Lookup</h2>
      <div class="hint">Look up a wallet by wallet file, dubz_ short address, or full public key. This is the 31.7 wallet resolve / wallet lookup explorer polish panel.</div>
      <form id="walletLookupForm" class="send-form">
        <div class="field full">
          <label for="walletLookupInput" class="small muted">Wallet file, dubz_ short address, or full public key</label>
          <input
            id="walletLookupInput"
            name="input"
            placeholder="wallet.miner.3001.json or dubz_xxxxx"
            value="${walletLookupDefaultValue}"
          />
        </div>
        <div class="actions">
          <button id="walletLookupBtn" type="submit">Lookup Wallet</button>
          <button type="button" onclick="loadDefaultWalletLookup()">Use Default Wallet</button>
          <button type="button" onclick="loadSelectedSendWallet()">Use Send From Wallet</button>
          <button type="button" onclick="useLookupWalletAsTo()">Use Lookup As To</button>
          <button type="button" onclick="useLookupWalletAsFrom()">Use Lookup As From</button>
          <span class="small muted">You can paste a wallet file name, a <span class="mono">dubz_</span> address, or the full RSA public key.</span>
        </div>
      </form>
      <div id="walletLookupResult" class="result" style="display:none"></div>
    </section>

    <section class="card full">
      <h2>Send Transaction</h2>
      <div class="hint">31.9 wallet action cleanup: cleaner lookup → preview → validate → send flow, smarter result reset, and faster wallet-to-form actions.</div>
      <form id="sendForm" class="send-form">
        <div class="field">
          <label for="sendFrom" class="small muted">From wallet file</label>
          <select id="sendFrom" name="fromWalletFile">
            ${walletOptionsHtml}
          </select>
        </div>
        <div class="field">
          <label for="sendTo" class="small muted">To wallet file, short address, or public key</label>
          <input id="sendTo" name="to" placeholder="wallet.miner.3002.json or dubz_xxxxx" />
        </div>
        <div class="field">
          <label for="sendAmount" class="small muted">Amount</label>
          <input id="sendAmount" name="amount" inputmode="numeric" placeholder="10" />
        </div>
        <div class="field">
          <label for="sendFee" class="small muted">Fee</label>
          <input id="sendFee" name="fee" inputmode="numeric" value="${deps.minFee}" />
        </div>
        <div class="actions">
          <button id="sendBtn" type="submit">Send TX</button>
          <button id="previewBtn" type="button" onclick="previewSendUi()">Preview TX</button>
          <button id="validateBtn" type="button" onclick="validateSendUi()">Validate Only</button>
          <button id="refreshHistoryBtn" type="button" onclick="refreshSendHistory({ showResult: true })">Refresh Send History</button>
          <button type="button" onclick="exportSendHistory()">Export History</button>
          <button type="button" onclick="clearSendHistoryUi()">Clear History</button>
          <button type="button" onclick="clearActionResults()">Clear Action Results</button>
          <span class="small muted">Tip: preview first, then send after reviewing the built tx.</span>
          <span id="historyMeta" class="small muted"></span>
        </div>
      </form>
      <div id="previewResult" class="result warn" style="display:none"></div>
      <div id="sendResult" class="result" style="display:none"></div>
    </section>

    <section class="card full">
      <h2>Recent Explorer Sends</h2>
      <div class="hint">This stays visible so you can capture successful and failed sends even after the mempool changes.</div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Status</th>
            <th>Via</th>
            <th>Height</th>
            <th>From</th>
            <th>To</th>
            <th>Amount</th>
            <th>Fee</th>
            <th>Tx ID</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody id="sendHistoryBody">
          ${sendHistoryHtml}
        </tbody>
      </table>
    </section>

    <section class="card half">
      <h2>Chain Summary</h2>
      <table>
        <tbody>
          <tr><th>Tip Hash</th><td class="mono">${htmlEscape(tip.hash)}</td></tr>
          <tr><th>Prev Hash</th><td class="mono">${htmlEscape(tip.prevHash || "GENESIS")}</td></tr>
          <tr><th>State Root</th><td class="mono">${htmlEscape(tip.stateRoot)}</td></tr>
          <tr><th>Timestamp</th><td>${htmlEscape(fmtTs(tip.ts))}</td></tr>
          <tr><th>Transactions in Tip</th><td>${tip.txs.length}</td></tr>
          <tr><th>Max Supply</th><td>${deps.maxSupply}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card half">
      <h2>Default Wallet Snapshot</h2>
      <table>
        <tbody>
          <tr><th>Wallet</th><td>${htmlEscape(deps.minerWalletFile)}</td></tr>
          <tr><th>Address</th><td>${htmlEscape(defaultWalletAddress)}</td></tr>
          <tr><th>Spendable</th><td>${defaultWalletSpendable}</td></tr>
          <tr><th>Immature</th><td>${defaultWalletImmature}</td></tr>
          <tr><th>Total</th><td>${defaultWalletTotal}</td></tr>
          <tr><th>Next Nonce</th><td>${defaultWalletNextNonce}</td></tr>
        </tbody>
      </table>
    </section>

    <section class="card full">
      <h2>Recent Blocks</h2>
      <table>
        <thead>
          <tr>
            <th>Height</th>
            <th>Hash</th>
            <th>Prev</th>
            <th>Diff</th>
            <th>Txs</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${recentBlocksHtml}
        </tbody>
      </table>
    </section>

    <section class="card full">
      <h2>Mempool</h2>
      <table>
        <thead>
          <tr>
            <th>Tx ID</th>
            <th>From</th>
            <th>To</th>
            <th>Amount</th>
            <th>Fee</th>
            <th>Nonce</th>
          </tr>
        </thead>
        <tbody>
          ${mempoolHtml}
        </tbody>
      </table>
    </section>
  </div>
</div>

<script>
  var historyPollMs = 5000;
  var historyPollTimer = null;
  var refreshInFlight = false;
  var lastLookupWallet = null;
  var lastPreviewPayloadKey = "";
  var lastPreviewData = null;

  function goHeight() {
    var el = document.getElementById("heightInput");
    var v = el && el.value ? el.value.trim() : "";
    if (!v) return;
    window.location.href = "/index?height=" + encodeURIComponent(v);
  }

  function buildPayloadKey(payload) {
    payload = payload || {};
    return JSON.stringify({
      fromWalletFile: String(payload.fromWalletFile || "").trim(),
      to: String(payload.to || "").trim(),
      amount: String(payload.amount || "").trim(),
      fee: String(payload.fee || "").trim()
    });
  }

  function showBox(box, className, title, badges, data) {
    if (!box) return;
    box.style.display = "block";
    box.className = className;
    box.innerHTML =
      "<strong>" + title + "</strong>" +
      (badges || "") +
      "<pre>" + escapeHtml(JSON.stringify(data, null, 2)) + "</pre>";
    try {
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {}
  }

  function hideBox(id) {
    var box = document.getElementById(id);
    if (!box) return;
    box.style.display = "none";
    box.innerHTML = "";
  }

  function clearPreviewState() {
    lastPreviewPayloadKey = "";
    lastPreviewData = null;
    hideBox("previewResult");
  }

  function clearActionResults() {
    clearPreviewState();
    hideBox("sendResult");
    hideBox("walletLookupResult");
  }

  function setResult(kind, title, data) {
    var box = document.getElementById("sendResult");
    if (!box) return;

    var badges = "";

    if (data && typeof data === "object") {
      if (data.code) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">code: ' + escapeHtml(data.code) + "</span>";
      }
      if (data.submittedVia) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">via: ' + escapeHtml(data.submittedVia) + "</span>";
      }
      if (data.txId) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">tx: ' + escapeHtml(shortValue(data.txId, 18)) + "</span>";
      }
      if (data.heightAtSend != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">height: ' + escapeHtml(String(data.heightAtSend)) + "</span>";
      }
      if (data.mempoolSizeAfter != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">mempool: ' + escapeHtml(String(data.mempoolSizeAfter)) + "</span>";
      }
      if (data.returned != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">rows: ' + escapeHtml(String(data.returned)) + "</span>";
      }
      if (data.cleared != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">cleared: ' + escapeHtml(String(data.cleared)) + "</span>";
      }
      if (data.totalCost != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">cost: ' + escapeHtml(String(data.totalCost)) + "</span>";
      }
      if (data.spendable != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">spendable: ' + escapeHtml(String(data.spendable)) + "</span>";
      }
      if (data.nextNonce != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">nonce: ' + escapeHtml(String(data.nextNonce)) + "</span>";
      }
    }

    showBox(
      box,
      "result " + (kind === "good" ? "good" : "bad"),
      title,
      badges,
      data
    );
  }

  function setPreviewResult(kind, data) {
    var box = document.getElementById("previewResult");
    if (!box) return;

    var badges = "";
    if (data && typeof data === "object") {
      if (data.fromAddress) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">from: ' + escapeHtml(data.fromAddress) + "</span>";
      }
      if (data.toAddress) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">to: ' + escapeHtml(data.toAddress) + "</span>";
      }
      if (data.amount != null) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">amount: ' + escapeHtml(String(data.amount)) + "</span>";
      }
      if (data.fee != null) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">fee: ' + escapeHtml(String(data.fee)) + "</span>";
      }
      if (data.totalCost != null) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">cost: ' + escapeHtml(String(data.totalCost)) + "</span>";
      }
      if (data.spendable != null) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">spendable: ' + escapeHtml(String(data.spendable)) + "</span>";
      }
      if (data.nextNonce != null) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">nonce: ' + escapeHtml(String(data.nextNonce)) + "</span>";
      }
      if (data.tx && data.tx.id) {
        badges += '<span class="badge ' + (kind === "good" ? "warn" : "bad") + '">tx: ' + escapeHtml(shortValue(data.tx.id, 18)) + "</span>";
      }
    }

    showBox(
      box,
      "result " + (kind === "good" ? "warn" : "bad"),
      kind === "good" ? "Transaction preview" : "Preview failed",
      badges,
      data
    );
  }

  function setTxResult(kind, data) {
    var title = kind === "good" ? "Transaction submitted" : "Transaction failed";
    setResult(kind, title, data);
  }

  function setValidateResult(kind, data) {
    var title = kind === "good" ? "Validation passed" : "Validation failed";
    setResult(kind, title, data);
  }

  function setHistoryResult(kind, data, title) {
    setResult(kind, title || (kind === "good" ? "History refreshed" : "History refresh failed"), data);
  }

  function setWalletLookupResult(kind, data) {
    var box = document.getElementById("walletLookupResult");
    if (!box) return;

    if (kind === "good" && data && data.wallet) {
      lastLookupWallet = data.wallet;
    } else {
      lastLookupWallet = null;
    }

    var title = kind === "good" ? "Wallet lookup found" : "Wallet lookup failed";
    var badges = "";

    if (data && typeof data === "object") {
      if (data.wallet && data.wallet.address) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">address: ' + escapeHtml(data.wallet.address) + "</span>";
      }
      if (data.wallet && data.wallet.walletFile) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">file: ' + escapeHtml(data.wallet.walletFile) + "</span>";
      }
      if (data.wallet && data.wallet.spendable != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">spendable: ' + escapeHtml(String(data.wallet.spendable)) + "</span>";
      }
      if (data.wallet && data.wallet.nextNonce != null) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">nextNonce: ' + escapeHtml(String(data.wallet.nextNonce)) + "</span>";
      }
      if (Array.isArray(data.similarWalletFiles) && data.similarWalletFiles.length) {
        badges += '<span class="badge ' + (kind === "good" ? "good" : "bad") + '">similar files: ' + escapeHtml(String(data.similarWalletFiles.length)) + "</span>";
      }
    }

    showBox(
      box,
      "result " + (kind === "good" ? "good" : "bad"),
      title,
      badges,
      data
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function shortValue(v, n) {
    var s = String(v || "");
    return s.length <= n ? s : s.slice(0, n) + "...";
  }

  function updateHistoryMeta(items) {
    var el = document.getElementById("historyMeta");
    if (!el) return;

    var count = Array.isArray(items) ? items.length : 0;
    el.textContent = "Last refreshed: " + new Date().toLocaleTimeString() + " | rows: " + count;
  }

  function renderSendHistory(items) {
    var body = document.getElementById("sendHistoryBody");
    if (!body) return;

    if (!items || !items.length) {
      body.innerHTML = '<tr><td colspan="10" class="muted">No explorer send history yet</td></tr>';
      updateHistoryMeta([]);
      return;
    }

    body.innerHTML = items.map(function(item) {
      var statusClass = item.ok ? "ok" : "bad-text";
      return (
        "<tr>" +
          "<td>" + escapeHtml(new Date(item.ts).toLocaleString()) + "</td>" +
          '<td class="' + statusClass + '">' + escapeHtml(item.ok ? "OK" : "FAIL") + "</td>" +
          "<td>" + escapeHtml(item.submittedVia || "-") + "</td>" +
          "<td>" + escapeHtml(item.heightAtSend == null ? "-" : String(item.heightAtSend)) + "</td>" +
          "<td>" + escapeHtml(item.fromAddress || item.fromWalletFile || "-") + "</td>" +
          "<td>" + escapeHtml(item.toAddress || item.toInput || "-") + "</td>" +
          "<td>" + escapeHtml(item.amount == null ? "-" : String(item.amount)) + "</td>" +
          "<td>" + escapeHtml(item.fee == null ? "-" : String(item.fee)) + "</td>" +
          "<td>" + escapeHtml(item.txId ? shortValue(item.txId, 18) : "-") + "</td>" +
          "<td>" + escapeHtml(item.error || "-") + "</td>" +
        "</tr>"
      );
    }).join("");

    updateHistoryMeta(items);
  }

  function collectSendPayload() {
    var fromWalletEl = document.getElementById("sendFrom");
    var toEl = document.getElementById("sendTo");
    var amountEl = document.getElementById("sendAmount");
    var feeEl = document.getElementById("sendFee");

    return {
      fromWalletFile: fromWalletEl ? fromWalletEl.value.trim() : "",
      to: toEl ? toEl.value.trim() : "",
      amount: amountEl ? amountEl.value.trim() : "",
      fee: feeEl ? feeEl.value.trim() : ""
    };
  }

  function useLookupWalletAsTo() {
    var sendToEl = document.getElementById("sendTo");
    if (!sendToEl || !lastLookupWallet) return;
    sendToEl.value = lastLookupWallet.walletFile || lastLookupWallet.address || "";
    clearPreviewState();
  }

  function useLookupWalletAsFrom() {
    var sendFromEl = document.getElementById("sendFrom");
    if (!sendFromEl || !lastLookupWallet || !lastLookupWallet.walletFile) return;
    sendFromEl.value = lastLookupWallet.walletFile;
    clearPreviewState();
  }

  async function lookupWalletUi(ev) {
    if (ev) ev.preventDefault();

    var btn = document.getElementById("walletLookupBtn");
    var inputEl = document.getElementById("walletLookupInput");
    var oldText = btn ? btn.textContent : "Lookup Wallet";
    var input = inputEl && inputEl.value ? inputEl.value.trim() : "";

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Looking up...";
    }

    try {
      var resp = await fetch("/wallet/lookup", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ input: input })
      });

      var data;
      try {
        data = await resp.json();
      } catch (e) {
        data = { ok: false, error: "bad json response" };
      }

      setWalletLookupResult(resp.ok && data && data.ok ? "good" : "bad", data);

      if (resp.ok && data && data.ok && data.wallet) {
        var sendToEl = document.getElementById("sendTo");
        if (sendToEl && !sendToEl.value.trim()) {
          sendToEl.value = data.wallet.walletFile || data.wallet.address || input;
        }
      }
    } catch (e) {
      setWalletLookupResult("bad", { ok: false, input: input, found: false, error: String(e) });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }

    return false;
  }

  function loadDefaultWalletLookup() {
    var inputEl = document.getElementById("walletLookupInput");
    if (!inputEl) return;
    inputEl.value = ${JSON.stringify(deps.minerWalletFile)};
  }

  function loadSelectedSendWallet() {
    var inputEl = document.getElementById("walletLookupInput");
    var fromEl = document.getElementById("sendFrom");
    if (!inputEl || !fromEl) return;
    inputEl.value = fromEl.value || "";
  }

  async function previewSendUi() {
    var btn = document.getElementById("previewBtn");
    var oldText = btn ? btn.textContent : "Preview TX";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Previewing...";
    }

    try {
      var payload = collectSendPayload();
      var resp = await fetch("/wallet/buildTx", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      var data;
      try {
        data = await resp.json();
      } catch (e) {
        data = { ok: false, error: "bad json response" };
      }

      if (resp.ok && data && data.ok) {
        lastPreviewPayloadKey = buildPayloadKey(payload);
        lastPreviewData = data;
        hideBox("sendResult");
        setPreviewResult("good", data);
      } else {
        clearPreviewState();
        setPreviewResult("bad", data);
      }
    } catch (e) {
      clearPreviewState();
      setPreviewResult("bad", { ok: false, error: String(e) });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  async function refreshSendHistory(opts) {
    opts = opts || {};
    var showResult = opts.showResult === true;
    var btn = document.getElementById("refreshHistoryBtn");
    var oldText = btn ? btn.textContent : "Refresh Send History";

    if (refreshInFlight) return;
    refreshInFlight = true;

    try {
      if (btn && showResult) {
        btn.disabled = true;
        btn.textContent = "Refreshing...";
      }

      var resp = await fetch("/debug/send-history?limit=12", {
        method: "GET",
        cache: "no-store"
      });

      var data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error("non-JSON response from /debug/send-history");
      }

      if (!resp.ok || !data || data.ok !== true) {
        if (showResult) {
          setHistoryResult("bad", data || { ok: false, error: "refresh failed" }, "History refresh failed");
        }
        return;
      }

      renderSendHistory(data.items || []);

      if (showResult) {
        setHistoryResult(
          "good",
          {
            ok: true,
            action: "refresh-send-history",
            count: data.count,
            returned: data.returned
          },
          "History refreshed"
        );
      }
    } catch (e) {
      if (showResult) {
        setHistoryResult(
          "bad",
          {
            ok: false,
            action: "refresh-send-history",
            error: String(e)
          },
          "History refresh failed"
        );
      }
    } finally {
      refreshInFlight = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || "Refresh Send History";
      }
    }
  }

  function startHistoryPolling() {
    stopHistoryPolling();
    historyPollTimer = window.setInterval(function() {
      if (document.hidden) return;
      refreshSendHistory({ showResult: false });
    }, historyPollMs);
  }

  function stopHistoryPolling() {
    if (historyPollTimer !== null) {
      window.clearInterval(historyPollTimer);
      historyPollTimer = null;
    }
  }

  function exportSendHistory() {
    window.open("/debug/send-history/export", "_blank");
  }

  async function clearSendHistoryUi() {
    var ok = window.confirm("Clear explorer send history?");
    if (!ok) return;

    try {
      var resp = await fetch("/debug/send-history/clear", {
        method: "POST"
      });

      var data = await resp.json();
      if (!resp.ok || !data || data.ok !== true) {
        setHistoryResult("bad", data || { ok: false, error: "clear failed" }, "History clear failed");
        return;
      }

      renderSendHistory([]);
      setHistoryResult("good", data, "History cleared");
    } catch (e) {
      setHistoryResult("bad", { ok: false, error: String(e) }, "History clear failed");
    }
  }

  async function validateSendUi() {
    var btn = document.getElementById("validateBtn");
    var oldText = btn ? btn.textContent : "Validate Only";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Validating...";
    }

    try {
      var payload = collectSendPayload();
      var resp = await fetch("/wallet/validateSend", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      var data = await resp.json();
      if (resp.ok && data && data.ok) {
        hideBox("previewResult");
        setValidateResult("good", data);
      } else {
        setValidateResult("bad", data);
      }
    } catch (e) {
      setValidateResult("bad", { ok: false, error: String(e) });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  async function submitSend(ev) {
    if (ev) ev.preventDefault();

    var btn = document.getElementById("sendBtn");
    if (btn) btn.disabled = true;

    try {
      var payload = collectSendPayload();
      var payloadKey = buildPayloadKey(payload);

      if (lastPreviewPayloadKey && lastPreviewPayloadKey !== payloadKey) {
        clearPreviewState();
      }

      var resp = await fetch("/wallet/send", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      var data;
      try {
        data = await resp.json();
      } catch (e) {
        data = { ok: false, error: "bad json response" };
      }

      setTxResult(resp.ok && data && data.ok ? "good" : "bad", data);

      if (resp.ok && data && data.ok) {
        clearPreviewState();
      }

      await refreshSendHistory({ showResult: false });
      return false;
    } catch (e) {
      setTxResult("bad", { ok: false, error: String(e) });
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.addEventListener("load", function() {
    var form = document.getElementById("sendForm");
    if (form) {
      form.addEventListener("submit", submitSend);
    }

    var walletLookupForm = document.getElementById("walletLookupForm");
    if (walletLookupForm) {
      walletLookupForm.addEventListener("submit", lookupWalletUi);
    }

    var openBlockBtn = document.getElementById("openBlockBtn");
    if (openBlockBtn) {
      openBlockBtn.addEventListener("click", function(ev) {
        ev.preventDefault();
        goHeight();
      });
    }

    var sendFromEl = document.getElementById("sendFrom");
    var sendToEl = document.getElementById("sendTo");
    var sendAmountEl = document.getElementById("sendAmount");
    var sendFeeEl = document.getElementById("sendFee");

    function handleSendFormChange() {
      var currentPayloadKey = buildPayloadKey(collectSendPayload());
      if (lastPreviewPayloadKey && currentPayloadKey !== lastPreviewPayloadKey) {
        clearPreviewState();
      }
    }

    if (sendFromEl) sendFromEl.addEventListener("change", handleSendFormChange);
    if (sendToEl) sendToEl.addEventListener("input", handleSendFormChange);
    if (sendAmountEl) sendAmountEl.addEventListener("input", handleSendFormChange);
    if (sendFeeEl) sendFeeEl.addEventListener("input", handleSendFormChange);

    refreshSendHistory({ showResult: false });
    startHistoryPolling();
  });

  document.addEventListener("visibilitychange", function() {
    if (document.hidden) return;
    refreshSendHistory({ showResult: false });
  });

  window.addEventListener("beforeunload", function() {
    stopHistoryPolling();
  });
</script>
</body>
</html>`;
}

function renderBlockExplorerHtml(
  deps: RpcServerDeps,
  rpcPort: number,
  height: number,
  block: RpcBlockJson
) {
  const txRows =
    block.txs.length === 0
      ? `<tr><td colspan="7" class="muted">No transactions</td></tr>`
      : block.txs
          .map(
            (t, idx) => `
      <tr>
        <td>${idx}</td>
        <td><a href="/tx/${encodeURIComponent(t.id)}">${htmlEscape(shortHash(t.id, 18))}</a></td>
        <td>${htmlEscape(t.type)}</td>
        <td>${htmlEscape(t.from ? shortKey(deps.shortAddress, t.from) : "null")}</td>
        <td>${htmlEscape(shortKey(deps.shortAddress, t.to))}</td>
        <td>${t.amount}</td>
        <td>${t.fee}</td>
      </tr>
    `
          )
          .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DubzChain Block ${height}</title>
<style>
  :root{
    --bg:#0b1020;
    --panel:#121933;
    --line:#273156;
    --text:#e8ecff;
    --muted:#9aa6d1;
    --accent:#7aa2ff;
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    background:radial-gradient(circle at top left,#18224a 0%,#0b1020 45%,#080c18 100%);
    color:var(--text);
    font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  }
  .wrap{max-width:1100px;margin:0 auto;padding:24px}
  .card{
    background:rgba(18,25,51,.92);
    border:1px solid var(--line);
    border-radius:18px;
    padding:18px;
    box-shadow:0 12px 40px rgba(0,0,0,.28);
    margin-bottom:16px;
  }
  table{width:100%;border-collapse:collapse}
  th,td{
    padding:10px 8px;
    border-bottom:1px solid rgba(255,255,255,.08);
    text-align:left;
    vertical-align:top;
    word-break:break-word;
  }
  th{color:var(--muted);font-weight:600}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  pre{
    margin:0;
    white-space:pre-wrap;
    background:rgba(10,16,32,.6);
    border:1px solid var(--line);
    border-radius:14px;
    padding:12px;
    font-size:12px;
  }
  .muted{color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Block #${height}</h1>
    <p><a href="/index">← Back to explorer</a> · RPC ${rpcPort} · P2P ${deps.port}</p>
  </div>

  <div class="card">
    <h2>Header</h2>
    <table>
      <tbody>
        <tr><th>Hash</th><td>${htmlEscape(block.hash)}</td></tr>
        <tr><th>Prev Hash</th><td>${htmlEscape(block.prevHash || "GENESIS")}</td></tr>
        <tr><th>Timestamp</th><td>${htmlEscape(fmtTs(block.ts))}</td></tr>
        <tr><th>Difficulty</th><td>${block.difficulty}</td></tr>
        <tr><th>Nonce</th><td>${block.nonce}</td></tr>
        <tr><th>State Root</th><td>${htmlEscape(block.stateRoot)}</td></tr>
        <tr><th>Tx Count</th><td>${block.txs.length}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Transactions</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>ID</th>
          <th>Type</th>
          <th>From</th>
          <th>To</th>
          <th>Amount</th>
          <th>Fee</th>
        </tr>
      </thead>
      <tbody>
        ${txRows}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Raw JSON</h2>
    <pre>${htmlEscape(JSON.stringify(block, null, 2))}</pre>
  </div>
</div>
</body>
</html>`;
}

function renderTransactionExplorerHtml(
  deps: RpcServerDeps,
  rpcPort: number,
  details: {
    tx: RpcTxJson;
    status: "confirmed" | "pending";
    blockHeight: number | null;
    blockHash: string | null;
    txIndex: number | null;
    chainHeight: number;
  }
) {
  const tx = details.tx;
  const confirmed = details.status === "confirmed";
  const confirmations =
    confirmed && details.blockHeight !== null
      ? Math.max(0, details.chainHeight - details.blockHeight + 1)
      : 0;

  const statusLabel = confirmed ? "Confirmed" : "Pending";
  const statusClass = confirmed ? "confirmed" : "pending";

  const blockValue =
    details.blockHeight === null
      ? `<span class="muted">Not mined yet</span>`
      : `<a href="/index?height=${details.blockHeight}">Block #${details.blockHeight}</a>`;

  const blockHashValue =
    details.blockHash === null
      ? `<span class="muted">Not available</span>`
      : htmlEscape(details.blockHash);

  const fromDisplay = tx.from
    ? htmlEscape(shortKey(deps.shortAddress, tx.from))
    : "COINBASE";

  const signatureValue = tx.signature
    ? htmlEscape(tx.signature)
    : `<span class="muted">No signature</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DubzChain Transaction ${htmlEscape(shortHash(tx.id, 18))}</title>

<style>
  :root{
    --bg:#0b1020;
    --panel:#121933;
    --panel-soft:#161f3f;
    --line:#273156;
    --text:#e8ecff;
    --muted:#9aa6d1;
    --accent:#7aa2ff;
    --good:#55d98a;
    --warning:#ffcc66;
  }

  *{box-sizing:border-box}

  body{
    margin:0;
    min-height:100vh;
    background:
      radial-gradient(circle at top left,#18224a 0%,#0b1020 46%,#080c18 100%);
    color:var(--text);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  }

  .wrap{
    max-width:1100px;
    margin:0 auto;
    padding:24px;
  }

  .topbar{
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:20px;
    flex-wrap:wrap;
    margin-bottom:16px;
  }

  .card{
    background:rgba(18,25,51,.94);
    border:1px solid var(--line);
    border-radius:18px;
    padding:20px;
    box-shadow:0 12px 40px rgba(0,0,0,.28);
    margin-bottom:16px;
  }

  .hero{
    background:
      linear-gradient(135deg,rgba(122,162,255,.13),rgba(18,25,51,.96));
  }

  h1,h2{
    margin-top:0;
  }

  h1{
    margin-bottom:8px;
    font-size:26px;
  }

  h2{
    font-size:18px;
    margin-bottom:14px;
  }

  a{
    color:var(--accent);
    text-decoration:none;
  }

  a:hover{
    text-decoration:underline;
  }

  .muted{
    color:var(--muted);
  }

  .status{
    display:inline-flex;
    align-items:center;
    gap:7px;
    padding:7px 11px;
    border-radius:999px;
    font-weight:700;
    border:1px solid currentColor;
  }

  .status::before{
    content:"";
    width:8px;
    height:8px;
    border-radius:50%;
    background:currentColor;
  }

  .confirmed{
    color:var(--good);
    background:rgba(85,217,138,.09);
  }

  .pending{
    color:var(--warning);
    background:rgba(255,204,102,.09);
  }

  .txid{
    overflow-wrap:anywhere;
    font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
    color:#cbd7ff;
  }

  .grid{
    display:grid;
    grid-template-columns:repeat(3,minmax(0,1fr));
    gap:12px;
  }

  .metric{
    background:rgba(10,16,32,.55);
    border:1px solid rgba(255,255,255,.08);
    border-radius:14px;
    padding:14px;
  }

  .metric-label{
    color:var(--muted);
    font-size:12px;
    margin-bottom:6px;
  }

  .metric-value{
    font-size:17px;
    font-weight:700;
    overflow-wrap:anywhere;
  }

  table{
    width:100%;
    border-collapse:collapse;
  }

  th,td{
    padding:12px 8px;
    border-bottom:1px solid rgba(255,255,255,.08);
    text-align:left;
    vertical-align:top;
    overflow-wrap:anywhere;
  }

  th{
    width:190px;
    color:var(--muted);
    font-weight:600;
  }

  code{
    font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
    font-size:12px;
    overflow-wrap:anywhere;
  }

  pre{
    margin:0;
    white-space:pre-wrap;
    overflow-wrap:anywhere;
    background:rgba(10,16,32,.65);
    border:1px solid var(--line);
    border-radius:14px;
    padding:14px;
    font-size:12px;
    overflow:auto;
  }

  @media (max-width:760px){
    .wrap{padding:14px}
    .grid{grid-template-columns:1fr}
    th{
      width:120px;
    }
  }
</style>
</head>

<body>
<div class="wrap">

  <div class="card hero">
    <div class="topbar">
      <div>
        <p style="margin-top:0">
          <a href="/index">← Back to DubzChain Explorer</a>
        </p>

        <h1>Transaction Details</h1>

        <div class="txid">${htmlEscape(tx.id)}</div>
      </div>

      <span class="status ${statusClass}">
        ${statusLabel}
      </span>
    </div>

    <p class="muted" style="margin-bottom:0">
      RPC ${rpcPort} · P2P ${deps.port}
    </p>
  </div>

  <div class="grid">
    <div class="metric">
      <div class="metric-label">Status</div>
      <div class="metric-value">${statusLabel}</div>
    </div>

    <div class="metric">
      <div class="metric-label">Confirmations</div>
      <div class="metric-value">${confirmations}</div>
    </div>

    <div class="metric">
      <div class="metric-label">Transaction Type</div>
      <div class="metric-value">${htmlEscape(tx.type)}</div>
    </div>

    <div class="metric">
      <div class="metric-label">Amount</div>
      <div class="metric-value">${tx.amount} DUBZ</div>
    </div>

    <div class="metric">
      <div class="metric-label">Fee</div>
      <div class="metric-value">${tx.fee} DUBZ</div>
    </div>

    <div class="metric">
      <div class="metric-label">Nonce</div>
      <div class="metric-value">${tx.nonce}</div>
    </div>
  </div>

  <div class="card">
    <h2>Transaction</h2>

    <table>
      <tbody>
        <tr>
          <th>Transaction ID</th>
          <td><code>${htmlEscape(tx.id)}</code></td>
        </tr>

        <tr>
          <th>Status</th>
          <td><span class="status ${statusClass}">${statusLabel}</span></td>
        </tr>

        <tr>
          <th>Block</th>
          <td>${blockValue}</td>
        </tr>

        <tr>
          <th>Block Hash</th>
          <td><code>${blockHashValue}</code></td>
        </tr>

        <tr>
          <th>Transaction Index</th>
          <td>${details.txIndex ?? "-"}</td>
        </tr>

        <tr>
          <th>Confirmations</th>
          <td>${confirmations}</td>
        </tr>

        <tr>
          <th>Timestamp</th>
          <td>${htmlEscape(fmtTs(tx.ts))}</td>
        </tr>

        <tr>
          <th>Type</th>
          <td>${htmlEscape(tx.type)}</td>
        </tr>

        <tr>
          <th>From</th>
          <td>
            <div>${fromDisplay}</div>
            ${
              tx.from
                ? `<pre style="margin-top:10px">${htmlEscape(tx.from)}</pre>`
                : ""
            }
          </td>
        </tr>

        <tr>
          <th>To</th>
          <td>
            <div>${htmlEscape(shortKey(deps.shortAddress, tx.to))}</div>
            <pre style="margin-top:10px">${htmlEscape(tx.to)}</pre>
          </td>
        </tr>

        <tr>
          <th>Amount</th>
          <td>${tx.amount} DUBZ</td>
        </tr>

        <tr>
          <th>Fee</th>
          <td>${tx.fee} DUBZ</td>
        </tr>

        <tr>
          <th>Nonce</th>
          <td>${tx.nonce}</td>
        </tr>

        <tr>
          <th>Signature</th>
          <td><code>${signatureValue}</code></td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Raw Transaction JSON</h2>
    <pre>${htmlEscape(JSON.stringify(tx, null, 2))}</pre>
  </div>

</div>
</body>
</html>`;
}

function buildProofResponse(args: {
  proof: any | null;
  kind: string;
  address?: string | null;
  pendingIndex?: number | null;
  source?: string | null;
  verifyStateProof: (p: any) => boolean;
}) {
  if (!args.proof) {
    return {
      ok: false,
      error: "proof not available",
      kind: args.kind,
      address: args.address ?? null,
      pendingIndex: args.pendingIndex ?? null,
      source: args.source ?? null,
    };
  }

  return {
    ok: true,
    kind: args.kind,
    address: args.address ?? null,
    pendingIndex: args.pendingIndex ?? null,
    source: args.source ?? null,
    verified: args.verifyStateProof(args.proof),
    proof: args.proof,
  };
}

export function startRpcServer(deps: RpcServerDeps) {
  const rpcHost = deps.rpcHost || "127.0.0.1";
  const rpcPort = deps.port + 1000;
  const startedAtMs = Date.now();
  const sendHistoryFile = getSendHistoryFile(deps.port);

  loadSendHistory(sendHistoryFile);

  const rpcAuthConfig = createRpcAuthConfig();
  const explorerDeploymentConfig = getExplorerDeploymentConfig();
  const telemetryConfig = createTelemetryConfig();
  console.log(
    `🔐 RPC auth ${getRpcAuthStats().enabled ? "enabled" : "disabled"} | write=${rpcAuthConfig.requireWriteAuth} | debug=${rpcAuthConfig.requireDebugAuth} | keys=${rpcAuthConfig.keys.size} | localhostBypass=${rpcAuthConfig.allowLocalhostWithoutKey}`
  );
  console.log(
    `🌍 Explorer deployment mode=${explorerDeploymentConfig.mode} | publicUrl=${explorerDeploymentConfig.publicUrl ?? "(none)"} | cors=${explorerDeploymentConfig.corsEnabled} | securityHeaders=${explorerDeploymentConfig.securityHeadersEnabled}`
  );
  console.log(
    `📡 Telemetry ${telemetryConfig.enabled ? "enabled" : "disabled"} | mode=${telemetryConfig.mode} | prefix=${telemetryConfig.metricsPrefix} | events=${telemetryConfig.includeRecentEvents}`
  );

  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method || "GET").toUpperCase();
      const url = new URL(req.url || "/", `http://127.0.0.1:${rpcPort}`);
      const path = url.pathname;
      const chain = deps.chain;
      const requestStartedAt = Date.now();
      res.once("finish", () => {
        const len = Number(res.getHeader("content-length") ?? 0);
        recordTelemetryRequest({
          method,
          path,
          statusCode: res.statusCode,
          durationMs: Date.now() - requestStartedAt,
          bytes: Number.isFinite(len) ? len : 0,
        });
      });

      if (handleExplorerOptions(req, res, explorerDeploymentConfig)) return;

      const authDecision = checkRpcAuth(req, method, path, rpcAuthConfig);
      if (!authDecision.ok) {
        return jsonSend(res, 401, {
          ok: false,
          error: "unauthorized",
          reason: authDecision.reason,
          auth: getRpcAuthStats(),
          headers: rpcAuthHeaders(),
        });
      }

      if (method === "GET" && path === "/rpc/auth") {
        return jsonSend(res, 200, {
          ok: true,
          auth: getRpcAuthStats(),
          publicPaths: Array.from(rpcAuthConfig.publicPaths.values()).sort(),
          usage: {
            header: "x-api-key: <key>",
            bearer: "Authorization: Bearer <key>",
            env: "DUBZ_RPC_API_KEY or DUBZ_RPC_API_KEYS=name=key,name2=key2",
          },
        });
      }

      if (method === "GET" && path === "/deployment") {
        return jsonSend(res, 200, {
          ok: true,
          explorerDeployment: getExplorerDeploymentStats(),
        });
      }

      if (method === "GET" && (path === "/profile" || path === "/network-profile")) {
        const profile = getActiveNetworkProfile(process.argv);
        return jsonSend(res, 200, exportNetworkProfileJson(profile));
      }

      if (method === "GET" && path === "/robots.txt") {
        return textSend(res, 200, robotsTxt(), "text/plain; charset=utf-8");
      }

      if (method === "GET" && (path === "/telemetry" || path === "/diagnostics/telemetry")) {
        const diagnostics = buildDiagnostics(deps, rpcHost, rpcPort, startedAtMs);
        return jsonSend(res, 200, {
          ok: true,
          telemetry: diagnostics.telemetry,
        });
      }

      if (method === "GET" && path === "/telemetry/events") {
        return jsonSend(res, 200, {
          ok: true,
          telemetry: getTelemetryStats(),
        });
      }

      if (method === "GET" && path === "/health") {
        const network = getNetworkStats();
        return jsonSend(res, 200, {
          ok: true,
          chainId: deps.chainId,
          version: deps.protocolVersion,
          p2pPort: deps.port,
          rpcPort,
          rpcHost,
          height: chain.height(),
          tipHash: chain.tipHash(),
          mempool: chain.mempool.size,
          orphans: chain.orphanCount(),
          peers: network.socketsOpen,
          syncProgressPct: network.sync.syncProgressPct,
          uptimeMs: Date.now() - startedAtMs,
        });
      }

      if (method === "GET" && path === "/status") {
        const diagnostics = buildDiagnostics(deps, rpcHost, rpcPort, startedAtMs);
        return jsonSend(res, 200, {
          ok: true,
          summary: {
            chainId: diagnostics.node.chainId,
            protocolVersion: diagnostics.node.protocolVersion,
            p2pPort: diagnostics.node.p2pPort,
            rpcPort: diagnostics.node.rpcPort,
            explorerMode: diagnostics.explorerDeployment.mode,
            explorerPublicReady: diagnostics.explorerDeployment.publicReady,
            telemetryEnabled: diagnostics.telemetry.config.enabled,
            telemetryMode: diagnostics.telemetry.config.mode,
            telemetryRequests: diagnostics.telemetry.stats.totalRequests,
            height: diagnostics.chain.height,
            tipHash: diagnostics.chain.tipHash,
            tipDifficulty: diagnostics.chain.tipDifficulty,
            mempool: diagnostics.chain.mempoolSize,
            orphans: diagnostics.chain.orphanCount,
            minted: diagnostics.chain.minted,
            rewardNow: diagnostics.chain.rewardNow,
            chainWork: diagnostics.chain.cumulativeWork,
            peersOpen: diagnostics.network.socketsOpen,
            peersInbound: diagnostics.network.inboundOpen,
            peersOutbound: diagnostics.network.outboundOpen,
            bestRemoteHeight: diagnostics.network.sync.bestRemoteHeight,
            syncTargetHeight: diagnostics.network.sync.syncTargetHeight,
            syncLagBlocks: diagnostics.network.sync.lagBlocks,
            syncProgressPct: diagnostics.network.sync.syncProgressPct,
            storageMode: diagnostics.storage.mode,
            pruningEnabled: diagnostics.storage.pruningEnabled,
            checkpointHeight: diagnostics.storage.checkpointHeight,
            uptimeMs: diagnostics.node.uptimeMs,
            uptimeHuman: diagnostics.node.uptimeHuman,
            rssBytes: diagnostics.process.rssBytes,
            rssHuman: diagnostics.process.rssHuman,
            heapUsedBytes: diagnostics.process.heapUsedBytes,
            heapUsedHuman: diagnostics.process.heapUsedHuman,
          },
        });
      }

      if (method === "GET" && (path === "/diagnostics" || path === "/diag")) {
        return jsonSend(res, 200, buildDiagnostics(deps, rpcHost, rpcPort, startedAtMs));
      }

      if (method === "GET" && (path === "/diagnostics/network" || path === "/network")) {
        return jsonSend(res, 200, {
          ok: true,
          network: getNetworkStats(),
        });
      }

      if (method === "GET" && path === "/peers") {
        const peers = getNetworkPeerStats();
        return jsonSend(res, 200, {
          ok: true,
          count: peers.length,
          peers,
        });
      }

      if (method === "GET" && path === "/sync") {
        const network = getNetworkStats();
        return jsonSend(res, 200, {
          ok: true,
          sync: network.sync,
          snapshotBootstrap: network.snapshotBootstrap,
        });
      }

      if (method === "GET" && path === "/storage") {
        return jsonSend(res, 200, {
          ok: true,
          storage: getStorageStatsSafe(deps),
        });
      }

      if (method === "GET" && path === "/metrics") {
        const diagnostics = buildDiagnostics(deps, rpcHost, rpcPort, startedAtMs);

        const metrics =
          buildMetricsText(deps, rpcHost, rpcPort, startedAtMs) +
          buildTelemetryMetricsText({
            node: diagnostics.node,
            chain: diagnostics.chain,
            network: diagnostics.network,
            storage: diagnostics.storage,
            process: diagnostics.process,
            rpcAuth: diagnostics.rpcAuth,
            explorerDeployment: diagnostics.explorerDeployment,
            
          });

        return textSend(res, 200, metrics, "text/plain; version=0.0.4; charset=utf-8");
      }

      if (method === "GET" && path === "/debug/replay-verify") {
        const out = buildReplayVerify(deps);
        return jsonSend(res, out.ok ? 200 : 501, out);
      }

      if (method === "GET" && path === "/debug/fork-compare") {
        return jsonSend(res, 200, buildForkCompareSummary(deps));
      }

      if (method === "POST" && path === "/debug/fork-compare") {
        let raw = "";
        try {
          raw = await deps.readRequestBody(req, FORK_COMPARE_BODY_LIMIT);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          const status = /too large/i.test(msg) ? 413 : 400;
          return jsonSend(res, status, {
            ok: false,
            error: msg,
            maxBodyBytes: FORK_COMPARE_BODY_LIMIT,
          });
        }

        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return jsonSend(res, 400, { ok: false, error: "bad json" });
        }

        try {
          const out = buildForkCompareAgainstCandidate(deps, parsed);
          return jsonSend(res, out.ok ? 200 : 400, out);
        } catch (e: any) {
          return jsonSend(res, 500, {
            ok: false,
            error: e?.message ?? String(e),
          });
        }
      }

      if (method === "GET" && path === "/debug/block-validate") {
        const rawHeight = parseInt(url.searchParams.get("height") || `${chain.height()}`, 10);
        const out = buildBlockValidate(deps, rawHeight);
        return jsonSend(res, out.ok ? 200 : 400, out);
      }

      if (method === "GET" && path === "/debug/state-root-check") {
        const rawHeight = parseInt(url.searchParams.get("height") || `${chain.height()}`, 10);
        const out = buildStateRootCheck(deps, rawHeight);
        return jsonSend(res, out.ok ? 200 : 400, out);
      }

      if (method === "GET" && path === "/debug/send-history") {
        const limitRaw = parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : 20, 1, SEND_HISTORY_MAX);

        return jsonSend(res, 200, {
          ok: true,
          count: explorerSendHistory.length,
          returned: Math.min(limit, explorerSendHistory.length),
          items: explorerSendHistory.slice(0, limit),
        });
      }

      if (method === "GET" && path === "/debug/send-history/export") {
        const exportedAt = Date.now();
        const body = JSON.stringify(
          {
            ok: true,
            exportedAt,
            exportedAtHuman: fmtTs(exportedAt),
            count: explorerSendHistory.length,
            items: explorerSendHistory,
          },
          null,
          2
        );

        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body, "utf8"),
          "cache-control": "no-store",
          "content-disposition": 'attachment; filename="dubzchain-send-history.json"',
        });
        return res.end(body);
      }

      if (method === "POST" && path === "/debug/send-history/clear") {
        const cleared = explorerSendHistory.length;
        clearSendHistory(sendHistoryFile);
        return jsonSend(res, 200, {
          ok: true,
          cleared,
          remaining: explorerSendHistory.length,
        });
      }

      if (method === "GET" && path === "/debug/runtime") {
        const mem = process.memoryUsage();
        return jsonSend(res, 200, {
          ok: true,
          startedAt: startedAtMs,
          startedAtIso: new Date(startedAtMs).toISOString(),
          uptimeMs: Date.now() - startedAtMs,
          uptimeHuman: fmtDuration(Date.now() - startedAtMs),
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
          cwd: process.cwd(),
          memory: {
            rssBytes: mem.rss,
            heapTotalBytes: mem.heapTotal,
            heapUsedBytes: mem.heapUsed,
            externalBytes: mem.external,
            arrayBuffersBytes: mem.arrayBuffers,
            rssHuman: fmtBytes(mem.rss),
            heapTotalHuman: fmtBytes(mem.heapTotal),
            heapUsedHuman: fmtBytes(mem.heapUsed),
            externalHuman: fmtBytes(mem.external),
            arrayBuffersHuman: fmtBytes(mem.arrayBuffers),
          },
        });
      }

      if (method === "GET" && path === "/debug/state") {
        const st = chain.getState();
        let pendingRewards = 0;
        for (const arr of st.pending.values()) pendingRewards += arr.length;

        return jsonSend(res, 200, {
          ok: true,
          height: chain.height(),
          tipHash: chain.tipHash(),
          minted: st.minted,
          maxSupply: deps.maxSupply,
          remainingSupply: Math.max(0, deps.maxSupply - st.minted),
          balancesTracked: st.balances.size,
          noncesTracked: st.nonces.size,
          pendingAccounts: st.pending.size,
          pendingRewards,
          balances: mapNumToObj(st.balances),
          nonces: mapNumToObj(st.nonces),
          pending: pendingMapToObj(st.pending),
        });
      }

      if (method === "GET" && path === "/debug/wallet/default") {
        const w = deps.loadWalletFromFile(deps.minerWalletFile);
        if (!w) return jsonSend(res, 500, { ok: false, error: "default wallet not found" });

        const balanceProof = chain.getBalanceProof(w.publicKey);
        const nonceProof = chain.getNonceProof(w.publicKey);

        return jsonSend(res, 200, {
          ok: true,
          walletFile: deps.minerWalletFile,
          address: deps.shortAddress(w.publicKey),
          publicKey: w.publicKey,
          spendable: chain.getSpendable(w.publicKey),
          immature: chain.getImmature(w.publicKey),
          total: chain.getTotal(w.publicKey),
          confirmedNonce: chain.confirmedNonce(w.publicKey),
          nextNonce: chain.nextNonce(w.publicKey),
          balanceProofAvailable: !!balanceProof,
          nonceProofAvailable: !!nonceProof,
        });
      }

      if (method === "GET" && path === "/height") {
        return jsonSend(res, 200, { height: chain.height() });
      }

      if (method === "GET" && path === "/tip") {
        const tip = chain.blocks[chain.blocks.length - 1];
        return jsonSend(res, 200, {
          height: chain.height(),
          hash: tip.hash,
          prevHash: tip.prevHash,
          ts: tip.ts,
          difficulty: tip.difficulty,
          txCount: tip.txs.length,
          stateRoot: tip.stateRoot,
        });
      }

      if (method === "GET" && path === "/snapshot/meta") {
        const meta = buildLiveSnapshotMeta(deps);
        return jsonSend(res, 200, {
          ok: true,
          snapshot: meta,
        });
      }

      if (method === "GET" && path === "/snapshot") {
        const snapshot = buildLiveSnapshot(deps);
        return jsonSend(res, 200, {
          ok: true,
          snapshot,
        });
      }

      if (method === "GET" && path === "/balance") {
        const addressRaw = url.searchParams.get("address");
        if (!addressRaw) return jsonSend(res, 400, { error: "missing address" });

        const address = safeDecodeURIComponent(addressRaw);
        return jsonSend(res, 200, {
          address,
          spendable: chain.getSpendable(address),
          immature: chain.getImmature(address),
          total: chain.getTotal(address),
          confirmedNonce: chain.confirmedNonce(address),
          nextNonce: chain.nextNonce(address),
        });
      }

      if (method === "GET" && path === "/nonce") {
        const addressRaw = url.searchParams.get("address");
        if (!addressRaw) return jsonSend(res, 400, { error: "missing address" });

        const address = safeDecodeURIComponent(addressRaw);
        return jsonSend(res, 200, {
          address,
          confirmedNonce: chain.confirmedNonce(address),
          nextNonce: chain.nextNonce(address),
        });
      }

      if (method === "GET" && path === "/wallet/resolve") {
        const inputRaw = url.searchParams.get("input");
        if (!inputRaw) {
          return jsonSend(res, 400, {
            ok: false,
            error: "missing input",
            note: "Use wallet file path, dubz_ short address, or public key.",
          });
        }

        const input = safeDecodeURIComponent(inputRaw);
        const info = resolveWalletInfo(deps, input);
        if (!info) {
          return jsonSend(res, 404, {
            ok: false,
            error: "wallet/address not found",
            input,
          });
        }

        return jsonSend(res, 200, {
          ok: true,
          wallet: info,
        });
      }

      if (method === "GET" && path === "/wallet/lookup") {
        const inputRaw = url.searchParams.get("input");
        if (!inputRaw) {
          return jsonSend(res, 400, {
            ok: false,
            input: "",
            found: false,
            error: "missing input",
            similarWalletFiles: [],
          });
        }

        const input = safeDecodeURIComponent(inputRaw);
        const out = buildWalletLookupSummary(deps, input);
        return jsonSend(res, out.ok ? 200 : 404, out);
      }

      if (method === "POST" && path === "/wallet/lookup") {
        const raw = await deps.readRequestBody(req);
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return jsonSend(res, 400, {
            ok: false,
            input: "",
            found: false,
            error: "bad json",
            similarWalletFiles: [],
          });
        }

        const input = String(parsed?.input || "").trim();
        const out = buildWalletLookupSummary(deps, input);
        return jsonSend(res, out.ok ? 200 : 404, out);
      }

      if (method === "POST" && path === "/wallet/validateSend") {
        const raw = await deps.readRequestBody(req);
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return jsonSend(res, 400, { ok: false, code: "bad_json", error: "bad json" });
        }

        const validation = validateWalletSendInputs(deps, parsed);
        return jsonSend(res, validation.ok ? 200 : 400, validation);
      }

      if (method === "GET" && path === "/proof/balance") {
        const addressRaw = url.searchParams.get("address");
        const walletFile = url.searchParams.get("walletFile");

        const resolved = walletFile
          ? deps.resolveAddressToPublicKey(walletFile)
          : addressRaw
          ? deps.resolveAddressToPublicKey(safeDecodeURIComponent(addressRaw))
          : deps.resolveAddressToPublicKey(deps.minerWalletFile);

        if (!resolved) return jsonSend(res, 404, { ok: false, error: "wallet/address not found" });

        const out = buildProofResponse({
          proof: chain.getBalanceProof(resolved.publicKey),
          kind: "balance",
          address: deps.shortAddress(resolved.publicKey),
          source: resolved.via,
          verifyStateProof: deps.verifyStateProof,
        });
        return jsonSend(res, out.ok ? 200 : 404, out);
      }

      if (method === "GET" && path === "/proof/nonce") {
        const addressRaw = url.searchParams.get("address");
        const walletFile = url.searchParams.get("walletFile");

        const resolved = walletFile
          ? deps.resolveAddressToPublicKey(walletFile)
          : addressRaw
          ? deps.resolveAddressToPublicKey(safeDecodeURIComponent(addressRaw))
          : deps.resolveAddressToPublicKey(deps.minerWalletFile);

        if (!resolved) return jsonSend(res, 404, { ok: false, error: "wallet/address not found" });

        const out = buildProofResponse({
          proof: chain.getNonceProof(resolved.publicKey),
          kind: "nonce",
          address: deps.shortAddress(resolved.publicKey),
          source: resolved.via,
          verifyStateProof: deps.verifyStateProof,
        });
        return jsonSend(res, out.ok ? 200 : 404, out);
      }

      if (method === "GET" && path === "/proof/pending") {
        const addressRaw = url.searchParams.get("address");
        const walletFile = url.searchParams.get("walletFile");
        const index = parseInt(url.searchParams.get("index") || "0", 10);

        if (!Number.isFinite(index) || index < 0) {
          return jsonSend(res, 400, { ok: false, error: "bad index" });
        }

        const resolved = walletFile
          ? deps.resolveAddressToPublicKey(walletFile)
          : addressRaw
          ? deps.resolveAddressToPublicKey(safeDecodeURIComponent(addressRaw))
          : deps.resolveAddressToPublicKey(deps.minerWalletFile);

        if (!resolved) return jsonSend(res, 404, { ok: false, error: "wallet/address not found" });

        const out = buildProofResponse({
          proof: chain.getPendingProof(resolved.publicKey, index),
          kind: "pending",
          address: deps.shortAddress(resolved.publicKey),
          pendingIndex: index,
          source: resolved.via,
          verifyStateProof: deps.verifyStateProof,
        });
        return jsonSend(res, out.ok ? 200 : 404, out);
      }

      if (method === "GET" && path === "/proof/minted") {
        const out = buildProofResponse({
          proof: chain.getMintedProof(),
          kind: "minted",
          source: "chain-state",
          verifyStateProof: deps.verifyStateProof,
        });
        return jsonSend(res, out.ok ? 200 : 404, out);
      }

      if (method === "POST" && path === "/proof/verify") {
        const raw = await deps.readRequestBody(req);
        let parsed: any;

        try {
          parsed = JSON.parse(raw);
        } catch {
          return jsonSend(res, 400, {
            ok: false,
            error: "bad json",
          });
        }

        const proof = parsed?.proof ?? parsed;

        if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
          return jsonSend(res, 400, {
            ok: false,
            error: "missing proof",
          });
        }

        const hasRoot = typeof proof.root === "string";
        const hasLeafHash = typeof proof.leafHash === "string";
        const hasClaim = proof.claim && typeof proof.claim === "object" && !Array.isArray(proof.claim);
        const hasProofArray = Array.isArray(proof.proof);

        if (!hasRoot || !hasLeafHash || !hasClaim || !hasProofArray) {
          return jsonSend(res, 400, {
            ok: false,
            error: "missing proof fields",
            verified: false,
          });
        }

        try {
          return jsonSend(res, 200, {
            ok: true,
            verified: deps.verifyStateProof(proof),
          });
        } catch (e: any) {
          return jsonSend(res, 400, {
            ok: false,
            error: e?.message ?? "invalid proof",
            verified: false,
          });
        }
      }

      if (method === "GET" && path === "/mempool") {
        const txs = Array.from(chain.mempool.values()).map((t) => t.toJSON());
        return jsonSend(res, 200, {
          size: txs.length,
          txs,
        });
      }

      if (method === "GET" && path === "/block") {
        const hash = url.searchParams.get("hash");
        const heightStr = url.searchParams.get("height");

        if (hash) {
          const blk = chain.blocks.find((b) => b.hash === hash);
          if (!blk) return jsonSend(res, 404, { error: "block not found" });
          return jsonSend(res, 200, { height: chain.blocks.indexOf(blk), block: blk.toJSON() });
        }

        if (heightStr !== null) {
          const height = parseInt(heightStr, 10);
          if (!Number.isFinite(height) || height < 0 || height >= chain.blocks.length) {
            return jsonSend(res, 400, { error: "bad height" });
          }
          return jsonSend(res, 200, { height, block: chain.blocks[height].toJSON() });
        }

        return jsonSend(res, 400, { error: "missing hash or height" });
      }

      if (method === "GET" && path === "/headers") {
        const from = parseInt(url.searchParams.get("from") || "0", 10);
        const count = parseInt(url.searchParams.get("count") || "25", 10);
        const start = Math.max(0, Number.isFinite(from) ? from : 0);
        const end = Math.min(chain.blocks.length, start + clamp(Number.isFinite(count) ? count : 25, 1, 500));
        return jsonSend(res, 200, {
          from: start,
          count: end - start,
          headers: chain.exportHeaders().slice(start, end),
        });
      }

      if (method === "POST" && (path === "/submitTx" || path === "/tx")) {
        const raw = await deps.readRequestBody(req);
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return jsonSend(res, 400, { error: "bad json" });
        }

        const tx = deps.Tx.fromJSON(parsed?.tx ?? parsed);
        const added = chain.addToMempool(tx);

        if (!added) {
          return jsonSend(res, 400, {
            ok: false,
            error: "tx rejected",
            mempool: chain.mempool.size,
          });
        }

        try {
          broadcastTx(tx);
        } catch {}

        return jsonSend(res, 200, {
          ok: true,
          txId: tx.id,
          mempool: chain.mempool.size,
          submittedVia: "local-mempool",
        });
      }

      if (method === "GET" && path === "/stats") {
        const st = chain.getState();
        const network = getNetworkStats();
        const storage = getStorageStatsSafe(deps);
        return jsonSend(res, 200, {
          height: chain.height(),
          tipHash: chain.tipHash(),
          mempool: chain.mempool.size,
          orphans: chain.orphanCount(),
          supply: st.minted,
          maxSupply: deps.maxSupply,
          rewardNow: deps.blockRewardAtHeight(chain.height() + 1),
          chainWork: cumulativeWorkFromBlocks(chain.blocks).toString(),
          peers: network.socketsOpen,
          bestRemoteHeight: network.sync.bestRemoteHeight,
          syncLagBlocks: network.sync.lagBlocks,
          storageMode: storage.mode,
          checkpointHeight: storage.checkpointHeight,
        });
      }

      if (method === "GET" && path === "/wallet/default") {
        const w = deps.loadWalletFromFile(deps.minerWalletFile);
        if (!w) return jsonSend(res, 500, { error: "default wallet not found" });

        return jsonSend(res, 200, {
          walletFile: deps.minerWalletFile,
          address: deps.shortAddress(w.publicKey),
          publicKey: w.publicKey,
          spendable: chain.getSpendable(w.publicKey),
          immature: chain.getImmature(w.publicKey),
          total: chain.getTotal(w.publicKey),
          confirmedNonce: chain.confirmedNonce(w.publicKey),
          nextNonce: chain.nextNonce(w.publicKey),
        });
      }

      if (method === "GET" && path === "/wallet/info") {
        const walletFile = url.searchParams.get("walletFile");
        const addressRaw = url.searchParams.get("address");

        const resolved = walletFile
          ? deps.resolveAddressToPublicKey(walletFile)
          : addressRaw
          ? deps.resolveAddressToPublicKey(safeDecodeURIComponent(addressRaw))
          : deps.resolveAddressToPublicKey(deps.minerWalletFile);

        if (!resolved) return jsonSend(res, 404, { error: "wallet not found" });

        return jsonSend(res, 200, {
          via: resolved.via,
          walletFile: resolved.walletFile ?? null,
          address: deps.shortAddress(resolved.publicKey),
          publicKey: resolved.publicKey,
          spendable: chain.getSpendable(resolved.publicKey),
          immature: chain.getImmature(resolved.publicKey),
          total: chain.getTotal(resolved.publicKey),
          confirmedNonce: chain.confirmedNonce(resolved.publicKey),
          nextNonce: chain.nextNonce(resolved.publicKey),
        });
      }

      if (method === "GET" && path === "/wallet/list") {
        try {
          const files = listWalletFiles();

          const wallets = files
            .map((f) => {
              const w = deps.loadWalletFromFile(f);
              if (!w) return null;
              return {
                walletFile: f,
                address: deps.shortAddress(w.publicKey),
                publicKey: w.publicKey,
                spendable: chain.getSpendable(w.publicKey),
                immature: chain.getImmature(w.publicKey),
                total: chain.getTotal(w.publicKey),
                confirmedNonce: chain.confirmedNonce(w.publicKey),
                nextNonce: chain.nextNonce(w.publicKey),
              };
            })
            .filter((x): x is NonNullable<typeof x> => !!x);

          return jsonSend(res, 200, {
            count: wallets.length,
            wallets,
          });
        } catch (e: any) {
          return jsonSend(res, 500, { error: e?.message ?? String(e) });
        }
      }

      if (method === "POST" && path === "/wallet/buildTx") {
        const raw = await deps.readRequestBody(req);
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return jsonSend(res, 400, { ok: false, code: "bad_json", error: "bad json" });
        }

        const validation = validateWalletSendInputs(deps, parsed);
        if (!validation.ok) {
          return jsonSend(res, 400, validation);
        }

        const fromWallet = deps.loadWalletFromFile(validation.fromWalletFile);
        const toResolved = deps.resolveAddressToPublicKey(String(validation.toInput));
        if (!fromWallet || !toResolved) {
          return jsonSend(res, 400, {
            ok: false,
            code: "build_failed",
            error: "unable to build tx from validated inputs",
          });
        }

        const nonce = chain.nextNonce(fromWallet.publicKey);
        const tx = new (deps.Tx as any)({
          type: "TRANSFER",
          from: fromWallet.publicKey,
          to: toResolved.publicKey,
          amount: validation.amount,
          fee: validation.fee,
          nonce,
        });
        tx.sign(fromWallet.privateKey);

        return jsonSend(res, 200, {
          ok: true,
          fromWalletFile: validation.fromWalletFile,
          fromAddress: validation.fromAddress,
          toInput: validation.toInput,
          toAddress: validation.toAddress,
          amount: validation.amount,
          fee: validation.fee,
          totalCost: validation.totalCost,
          spendable: validation.spendable,
          immature: validation.immature,
          total: validation.total,
          confirmedNonce: validation.confirmedNonce,
          nextNonce: validation.nextNonce,
          tx: tx.toJSON(),
        });
      }

      if (method === "POST" && (path === "/wallet/send" || path === "/send")) {
        const raw = await deps.readRequestBody(req);
        let parsed: any;

        try {
          parsed = JSON.parse(raw);
        } catch {
          const fail = { ok: false, code: "bad_json", error: "bad json" };
          pushSendHistory(
            {
              ts: Date.now(),
              fromWalletFile: null,
              fromAddress: null,
              toInput: null,
              toAddress: null,
              amount: null,
              fee: null,
              txId: null,
              ok: false,
              submittedVia: null,
              error: fail.error,
              heightAtSend: chain.height(),
              tipHashAtSend: chain.tipHash(),
              mempoolSizeAfter: chain.mempool.size,
            },
            sendHistoryFile
          );
          return jsonSend(res, 400, fail);
        }

        const validation = validateWalletSendInputs(deps, parsed);
        if (!validation.ok) {
          pushSendHistory(
            {
              ts: Date.now(),
              fromWalletFile: validation.fromWalletFile,
              fromAddress: validation.fromAddress ?? null,
              toInput: validation.toInput ?? null,
              toAddress: validation.toAddress ?? null,
              amount: validation.amount ?? null,
              fee: validation.fee ?? null,
              txId: null,
              ok: false,
              submittedVia: null,
              error: validation.error ?? validation.code ?? "validation failed",
              heightAtSend: chain.height(),
              tipHashAtSend: chain.tipHash(),
              mempoolSizeAfter: chain.mempool.size,
            },
            sendHistoryFile
          );
          return jsonSend(res, 400, validation);
        }

        const fromWallet = deps.loadWalletFromFile(validation.fromWalletFile);
        const toResolved = deps.resolveAddressToPublicKey(String(validation.toInput));
        if (!fromWallet || !toResolved) {
          const fail = {
            ok: false,
            code: "build_failed",
            error: "unable to build tx from validated inputs",
          };
          pushSendHistory(
            {
              ts: Date.now(),
              fromWalletFile: validation.fromWalletFile,
              fromAddress: validation.fromAddress ?? null,
              toInput: validation.toInput ?? null,
              toAddress: validation.toAddress ?? null,
              amount: validation.amount ?? null,
              fee: validation.fee ?? null,
              txId: null,
              ok: false,
              submittedVia: null,
              error: fail.error,
              heightAtSend: chain.height(),
              tipHashAtSend: chain.tipHash(),
              mempoolSizeAfter: chain.mempool.size,
            },
            sendHistoryFile
          );
          return jsonSend(res, 400, fail);
        }

        const nonce = chain.nextNonce(fromWallet.publicKey);
        const tx = new (deps.Tx as any)({
          type: "TRANSFER",
          from: fromWallet.publicKey,
          to: toResolved.publicKey,
          amount: validation.amount,
          fee: validation.fee,
          nonce,
        });
        tx.sign(fromWallet.privateKey);

        const recordedAt = Date.now();
        const heightAtSend = chain.height();
        const tipHashAtSend = chain.tipHash();

        const okNet = await deps.submitTxToLocalNode(deps.port, tx);

        if (okNet) {
          const out = {
            ok: true,
            submittedVia: "websocket",
            txId: tx.id,
            fromWalletFile: validation.fromWalletFile,
            fromAddress: validation.fromAddress,
            toInput: validation.toInput,
            toAddress: validation.toAddress,
            amount: validation.amount,
            fee: validation.fee,
            totalCost: validation.totalCost,
            spendable: validation.spendable,
            immature: validation.immature,
            total: validation.total,
            confirmedNonce: validation.confirmedNonce,
            nextNonce: validation.nextNonce,
            recordedAt,
            recordedAtHuman: fmtTs(recordedAt),
            heightAtSend,
            tipHashAtSend,
            mempoolSizeAfter: chain.mempool.size,
            historyCount: Math.min(explorerSendHistory.length + 1, SEND_HISTORY_MAX),
          };

          pushSendHistory(
            {
              ts: recordedAt,
              fromWalletFile: validation.fromWalletFile,
              fromAddress: validation.fromAddress ?? null,
              toInput: validation.toInput ?? null,
              toAddress: validation.toAddress ?? null,
              amount: validation.amount ?? null,
              fee: validation.fee ?? null,
              txId: tx.id,
              ok: true,
              submittedVia: out.submittedVia,
              error: null,
              heightAtSend,
              tipHashAtSend,
              mempoolSizeAfter: chain.mempool.size,
            },
            sendHistoryFile
          );

          return jsonSend(res, 200, out);
        }

        const added = chain.addToMempool(tx);
        if (!added) {
          const out = {
            ok: false,
            code: "tx_rejected",
            error: "tx rejected",
            txId: tx.id,
            fromWalletFile: validation.fromWalletFile,
            fromAddress: validation.fromAddress,
            toInput: validation.toInput,
            toAddress: validation.toAddress,
            amount: validation.amount,
            fee: validation.fee,
            totalCost: validation.totalCost,
            spendable: validation.spendable,
            immature: validation.immature,
            total: validation.total,
            confirmedNonce: validation.confirmedNonce,
            nextNonce: validation.nextNonce,
            recordedAt,
            recordedAtHuman: fmtTs(recordedAt),
            heightAtSend,
            tipHashAtSend,
            mempoolSizeAfter: chain.mempool.size,
            historyCount: Math.min(explorerSendHistory.length + 1, SEND_HISTORY_MAX),
          };

          pushSendHistory(
            {
              ts: recordedAt,
              fromWalletFile: validation.fromWalletFile,
              fromAddress: validation.fromAddress ?? null,
              toInput: validation.toInput ?? null,
              toAddress: validation.toAddress ?? null,
              amount: validation.amount ?? null,
              fee: validation.fee ?? null,
              txId: tx.id,
              ok: false,
              submittedVia: "local-mempool",
              error: out.error,
              heightAtSend,
              tipHashAtSend,
              mempoolSizeAfter: chain.mempool.size,
            },
            sendHistoryFile
          );

          return jsonSend(res, 400, out);
        }

        try {
          broadcastTx(tx);
        } catch {}

        const out = {
          ok: true,
          submittedVia: "local-mempool",
          txId: tx.id,
          fromWalletFile: validation.fromWalletFile,
          fromAddress: validation.fromAddress,
          toInput: validation.toInput,
          toAddress: validation.toAddress,
          amount: validation.amount,
          fee: validation.fee,
          totalCost: validation.totalCost,
          spendable: validation.spendable,
          immature: validation.immature,
          total: validation.total,
          confirmedNonce: validation.confirmedNonce,
          nextNonce: validation.nextNonce,
          recordedAt,
          recordedAtHuman: fmtTs(recordedAt),
          heightAtSend,
          tipHashAtSend,
          mempoolSizeAfter: chain.mempool.size,
          historyCount: Math.min(explorerSendHistory.length + 1, SEND_HISTORY_MAX),
        };

        pushSendHistory(
          {
            ts: recordedAt,
            fromWalletFile: validation.fromWalletFile,
            fromAddress: validation.fromAddress ?? null,
            toInput: validation.toInput ?? null,
            toAddress: validation.toAddress ?? null,
            amount: validation.amount ?? null,
            fee: validation.fee ?? null,
            txId: tx.id,
            ok: true,
            submittedVia: out.submittedVia,
            error: null,
            heightAtSend,
            tipHashAtSend,
            mempoolSizeAfter: chain.mempool.size,
          },
          sendHistoryFile
        );

        return jsonSend(res, 200, out);
      }

      if (method === "GET" && path.startsWith("/tx/")) {
        let txId = "";

        try {
          txId = decodeURIComponent(path.slice("/tx/".length)).trim();
        } catch {
          return htmlSend(
            res,
            400,
            `<!doctype html>
            <html>
              <body style="font-family:sans-serif;background:#0b1020;color:#fff;padding:24px">
                <h1>Invalid transaction ID</h1>
                <p>The transaction ID could not be decoded.</p>
                <p><a href="/index" style="color:#7aa2ff">Back to explorer</a></p>
              </body>
            </html>`
          );
        }

        if (!txId) {
          return htmlSend(
            res,
            400,
            `<!doctype html>
            <html>
              <body style="font-family:sans-serif;background:#0b1020;color:#fff;padding:24px">
                <h1>Missing transaction ID</h1>
                <p><a href="/index" style="color:#7aa2ff">Back to explorer</a></p>
              </body>
            </html>`
          );
        }

        let foundTx: RpcTxJson | null = null;
        let status: "confirmed" | "pending" = "pending";
        let blockHeight: number | null = null;
        let blockHash: string | null = null;
        let txIndex: number | null = null;

        const pendingTx = chain.mempool.get(txId);

        if (pendingTx) {
          foundTx = pendingTx.toJSON() as RpcTxJson;
        } else {
          for (let height = chain.blocks.length - 1; height >= 0; height--) {
            const block = chain.blocks[height];
            const index = block.txs.findIndex((tx) => tx.id === txId);

            if (index !== -1) {
              foundTx = block.txs[index];
              status = "confirmed";
              blockHeight = height;
              blockHash = block.hash;
              txIndex = index;
              break;
            }
          }
        }

        if (!foundTx) {
          return htmlSend(
            res,
            404,
            `<!doctype html>
            <html lang="en">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width,initial-scale=1" />
              <title>Transaction Not Found</title>
            </head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b1020;color:#fff;padding:24px">
              <h1>Transaction not found</h1>
              <p style="word-break:break-all;color:#9aa6d1">${htmlEscape(txId)}</p>
              <p>The transaction is not currently in the blockchain or mempool.</p>
              <p><a href="/index" style="color:#7aa2ff">← Back to explorer</a></p>
            </body>
            </html>`
          );
        }

        return htmlSend(
          res,
          200,
          renderTransactionExplorerHtml(deps, rpcPort, {
            tx: foundTx,
            status,
            blockHeight,
            blockHash,
            txIndex,
            chainHeight: chain.height(),
          })
        );
      }

      if (method === "GET" && path === "/index") {
        const heightStr = url.searchParams.get("height");

        if (heightStr !== null) {
          const height = parseInt(heightStr, 10);
          if (!Number.isFinite(height) || height < 0 || height >= chain.blocks.length) {
            return htmlSend(
              res,
              400,
              `<!doctype html><html><body style="font-family:sans-serif;background:#0b1020;color:#fff;padding:24px">
                <p>Bad block height.</p>
                <p><a href="/index" style="color:#7aa2ff">Back to explorer</a></p>
              </body></html>`
            );
          }
          return htmlSend(
            res,
            200,
            renderBlockExplorerHtml(deps, rpcPort, height, chain.blocks[height].toJSON())
          );
        }

        return htmlSend(res, 200, renderExplorerHtml(deps, rpcPort, startedAtMs));
      }

      if (method === "GET" && path === "/") {
        return textSend(
          res,
          200,
          [
            "DubzChain RPC",
            "",
            "Node RPC",
            "GET  /health",
            "GET  /status",
            "GET  /diagnostics",
            "GET  /diag",
            "GET  /diagnostics/network",
            "GET  /network",
            "GET  /peers",
            "GET  /sync",
            "GET  /storage",
            "GET  /metrics",
            "GET  /debug/runtime",
            "GET  /debug/state",
            "GET  /debug/wallet/default",
            "GET  /debug/replay-verify",
            "GET  /debug/fork-compare",
            "POST /debug/fork-compare",
            "GET  /debug/block-validate?height=123",
            "GET  /debug/state-root-check?height=123",
            "GET  /debug/send-history",
            "GET  /debug/send-history/export",
            "POST /debug/send-history/clear",
            "GET  /height",
            "GET  /tip",
            "GET  /snapshot/meta",
            "GET  /snapshot",
            "GET  /balance?address=PUBLIC_KEY",
            "GET  /nonce?address=PUBLIC_KEY",
            "GET  /proof/balance?address=dubz_xxxxx",
            "GET  /proof/balance?walletFile=wallet.miner.3001.json",
            "GET  /proof/nonce?address=dubz_xxxxx",
            "GET  /proof/pending?address=dubz_xxxxx&index=0",
            "GET  /proof/minted",
            "POST /proof/verify",
            "GET  /mempool",
            "GET  /block?height=... or /block?hash=...",
            "GET  /headers?from=0&count=25",
            "GET  /stats",
            "POST /submitTx",
            "POST /tx",
            "",
            "Wallet RPC",
            "GET  /wallet/default",
            "GET  /wallet/info?walletFile=wallet.miner.3001.json",
            "GET  /wallet/info?address=dubz_xxxxx",
            "GET  /wallet/resolve?input=wallet.miner.3001.json",
            "GET  /wallet/lookup?input=wallet.miner.3001.json",
            "POST /wallet/lookup",
            "GET  /wallet/list",
            "POST /wallet/validateSend",
            "POST /wallet/buildTx",
            "POST /wallet/send",
            "POST /send",
            "",
            "Explorer",
            "GET  /index",
            "GET  /index?height=123",
            "GET  /tx/<transaction-id>",
          ].join("\n")
        );
      }

      return jsonSend(res, 404, { error: "not found" });
    } catch (e: any) {
      return jsonSend(res, 500, { error: e?.message ?? String(e) });
    }
  });

  server.listen(rpcPort, rpcHost, () => {
    console.log(`🛰️ RPC running on http://${rpcHost}:${rpcPort}`);
    console.log(`🧭 Explorer running on http://${rpcHost}:${rpcPort}/index`);
    console.log(`📊 Status endpoint http://${rpcHost}:${rpcPort}/status`);
    console.log(`🛠️ Diagnostics endpoint http://${rpcHost}:${rpcPort}/diagnostics`);
    console.log(`🚀 Deployment endpoint http://${rpcHost}:${rpcPort}/deployment`);
    console.log(`🌐 Network endpoint http://${rpcHost}:${rpcPort}/diagnostics/network`);
    console.log(`👥 Peers endpoint http://${rpcHost}:${rpcPort}/peers`);
    console.log(`🔄 Sync endpoint http://${rpcHost}:${rpcPort}/sync`);
    console.log(`💽 Storage endpoint http://${rpcHost}:${rpcPort}/storage`);
    console.log(`🔐 RPC auth endpoint http://${rpcHost}:${rpcPort}/rpc/auth`);
    console.log(`🧪 Replay verify endpoint http://${rpcHost}:${rpcPort}/debug/replay-verify`);
    console.log(`🧪 Fork compare endpoint http://${rpcHost}:${rpcPort}/debug/fork-compare`);
    console.log(`🧪 Fork compare body limit ${FORK_COMPARE_BODY_LIMIT} bytes`);
    console.log(`👛 Wallet resolve endpoint http://${rpcHost}:${rpcPort}/wallet/resolve?input=${encodeURIComponent(deps.minerWalletFile)}`);
    console.log(`🔎 Wallet lookup endpoint http://${rpcHost}:${rpcPort}/wallet/lookup?input=${encodeURIComponent(deps.minerWalletFile)}`);
    console.log(`👛 Wallet validate endpoint http://${rpcHost}:${rpcPort}/wallet/validateSend`);
    console.log(`🧪 Block validate endpoint http://${rpcHost}:${rpcPort}/debug/block-validate?height=${deps.chain.height()}`);
    console.log(`🧪 State-root check endpoint http://${rpcHost}:${rpcPort}/debug/state-root-check?height=${deps.chain.height()}`);
    console.log(`📈 Metrics endpoint http://${rpcHost}:${rpcPort}/metrics`);
    console.log(`📡 Telemetry endpoint http://${rpcHost}:${rpcPort}/telemetry`);
    console.log(`🧾 Send history endpoint http://${rpcHost}:${rpcPort}/debug/send-history`);
    console.log(`💾 Send history export http://${rpcHost}:${rpcPort}/debug/send-history/export`);
    console.log(`🗂️ Send history file ${getSendHistoryFile(deps.port)}`);
  });

  server.on("error", (e) => {
    console.log("RPC error:", (e as any)?.message ?? String(e));
  });

  return server;
}