import { getActiveNetworkProfile } from "./mainnet-profile";
import * as crypto from "crypto";
import * as fs from "fs";
import * as pathMod from "path";
import {
  loadChainstate,
  saveChainstate,
  getChainstateStats,
  makeChainstateJson,
  chainstateToMaps,
  mapsToChainstateRecords,
  chainstateFileFor,
  chainstateBackupFileFor,
  type ChainstateStats as SeparatedChainstateStats,
} from "./chainstate";
import {
  asyncDiskQueue,
  getAsyncDiskQueueStats,
  type AsyncDiskQueueStats,
} from "./async-disk";
import {
  beginCrashJournal,
  updateCrashJournal,
  completeCrashJournal,
  abortCrashJournal,
  recoverCrashJournal,
  getCrashJournalStats,
  crashJournalFileFor,
  crashJournalBackupFileFor,
  type CrashJournalStats,
} from "./crash-journal";
import {
  recoverChainFiles,
  getChainRepairStats,
  type ChainRepairStats,
} from "./chain-repair";

/* =========================
   Chain Identity (Commitments)
========================= */
const ACTIVE_PROFILE = getActiveNetworkProfile(process.argv);

export const CHAIN_ID = ACTIVE_PROFILE.network.chainId;
export const PROTOCOL_VERSION = ACTIVE_PROFILE.network.protocolVersion;
export const NETWORK_MAGIC = ACTIVE_PROFILE.network.networkMagic;

/* =========================
   Helpers
========================= */
function sha256(data: string | Buffer) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function now() {
  return Date.now();
}

type ReadJsonResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; reason: "missing" | "parse-error" | "read-error"; error?: string };

function readJSONDetailed<T = any>(filePath: string): ReadJsonResult<T> {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch (e: any) {
      return {
        ok: false,
        reason: "parse-error",
        error: e?.message ?? String(e),
      };
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: false, reason: "missing" };
    return {
      ok: false,
      reason: "read-error",
      error: e?.message ?? String(e),
    };
  }
}

function readJSON(path: string): any | null {
  const res = readJSONDetailed(path);
  return res.ok ? res.data : null;
}

function fsyncDirBestEffort(filePath: string) {
  try {
    const dir = pathMod.dirname(filePath) || ".";
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {}
}

function writeTextAtomic(path: string, text: string) {
  const dir = pathMod.dirname(path) || ".";
  const base = pathMod.basename(path);
  const tmp = pathMod.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmp, path);
    fsyncDirBestEffort(path);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function writeJSON(path: string, obj: any) {
  writeTextAtomic(path, JSON.stringify(obj, null, 2));
}

function backupFileFor(filePath: string) {
  return `${filePath}.bak`;
}

function copyFileAtomic(srcPath: string, dstPath: string) {
  const dir = pathMod.dirname(dstPath) || ".";
  const base = pathMod.basename(dstPath);
  const tmp = pathMod.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  let fd: number | null = null;
  try {
    fs.copyFileSync(srcPath, tmp);
    fd = fs.openSync(tmp, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmp, dstPath);
    fsyncDirBestEffort(dstPath);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function quarantineFile(filePath: string, tag = "bad"): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const dir = pathMod.dirname(filePath) || ".";
    const base = pathMod.basename(filePath);
    const quarantined = pathMod.join(dir, `${base}.${tag}.${Date.now()}`);
    fs.renameSync(filePath, quarantined);
    fsyncDirBestEffort(quarantined);
    return quarantined;
  } catch {
    return null;
  }
}

function isSafeInt(n: any) {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}
function approxBytes(obj: any) {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/* =========================
   Merkle Tree (Generic) + Tx Proofs + State Proofs
========================= */
export type MerkleProofNode = { position: "left" | "right"; hash: string };
export type MerkleProof = { txId: string; root: string; proof: MerkleProofNode[] };

const MERKLE_LAYERS_CACHE_MAX = 64;
const merkleLayersCache = new Map<string, string[][]>();
const merkleProofCache = new Map<string, MerkleProof>();

function genericMerkleCacheKey(leafHashes: string[]): string {
  return sha256(`${leafHashes.length}|${leafHashes.join(",")}`);
}
function touchCache<K, V>(m: Map<K, V>, k: K) {
  const v = m.get(k);
  if (v === undefined) return;
  m.delete(k);
  m.set(k, v);
}
function capCache<K, V>(m: Map<K, V>, max: number) {
  while (m.size > max) {
    const it = m.keys().next();
    if (it.done) break;
    m.delete(it.value);
  }
}
function buildMerkleLayersFromLeafHashes(leafHashes: string[]): string[][] {
  if (leafHashes.length === 0) return [[sha256(JSON.stringify([]))]];

  const key = genericMerkleCacheKey(leafHashes);
  const cached = merkleLayersCache.get(key);
  if (cached) {
    touchCache(merkleLayersCache, key);
    return cached;
  }

  let layer = leafHashes.slice();
  const layers: string[][] = [layer];

  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(sha256(left + right));
    }
    layers.push(next);
    layer = next;
  }

  merkleLayersCache.set(key, layers);
  capCache(merkleLayersCache, MERKLE_LAYERS_CACHE_MAX);
  return layers;
}
function merkleRootFromLeafHashes(leafHashes: string[]): string {
  const layers = buildMerkleLayersFromLeafHashes(leafHashes);
  return layers[layers.length - 1][0];
}
function generateMerkleProofFromLeafHash(
  leafHashes: string[],
  targetLeafHash: string
): { root: string; proof: MerkleProofNode[] } | null {
  const idx0 = leafHashes.indexOf(targetLeafHash);
  if (idx0 === -1) return null;

  const layers = buildMerkleLayersFromLeafHashes(leafHashes);
  const root = layers[layers.length - 1][0];

  const proof: MerkleProofNode[] = [];
  let idx = idx0;

  for (let layer = 0; layer < layers.length - 1; layer++) {
    const cur = layers[layer];
    const isRight = idx % 2 === 1;
    const pairIndex = isRight ? idx - 1 : idx + 1;
    const pairHash = pairIndex < cur.length ? cur[pairIndex] : cur[idx];

    proof.push({ position: isRight ? "left" : "right", hash: pairHash });
    idx = Math.floor(idx / 2);
  }

  return { root, proof };
}
function verifyMerkleLeafProof(leafHash: string, proof: MerkleProofNode[], root: string): boolean {
  let hash = leafHash;
  for (const step of proof) {
    if (step.position === "left") hash = sha256(step.hash + hash);
    else hash = sha256(hash + step.hash);
  }
  return hash === root;
}

function merkleCacheKeyForTxIds(txIds: string[]): string {
  return genericMerkleCacheKey(txIds.map((id) => sha256(id)));
}
function merkleRootFromTxIds(txIds: string[]): string {
  return merkleRootFromLeafHashes(txIds.map((id) => sha256(id)));
}
function merkleRootForBlockTxs(txs: Tx[]): string {
  return merkleRootFromTxIds(txs.map((t) => t.id));
}
export function generateMerkleProof(txIds: string[], targetId: string): MerkleProof | null {
  const layersKey = merkleCacheKeyForTxIds(txIds);
  const targetLeafHash = sha256(targetId);

  const proofKey = `${layersKey}:${targetId}`;
  const cached = merkleProofCache.get(proofKey);
  const leafHashes = txIds.map((id) => sha256(id));
  const root = merkleRootFromLeafHashes(leafHashes);

  if (cached && cached.root === root) {
    touchCache(merkleProofCache, proofKey);
    return cached;
  }

  const gp = generateMerkleProofFromLeafHash(leafHashes, targetLeafHash);
  if (!gp) return null;

  const out: MerkleProof = { txId: targetId, root: gp.root, proof: gp.proof };
  merkleProofCache.set(proofKey, out);
  capCache(merkleProofCache, MERKLE_LAYERS_CACHE_MAX * 4);
  return out;
}
export function verifyMerkleProof(txId: string, proof: MerkleProofNode[], root: string): boolean {
  return verifyMerkleLeafProof(sha256(txId), proof, root);
}

/* =========================
   Monetary Policy
========================= */
export const MAX_SUPPLY = ACTIVE_PROFILE.monetary.maxSupply;
const HALVING_INTERVAL = ACTIVE_PROFILE.monetary.halvingInterval;
const INITIAL_REWARD = ACTIVE_PROFILE.monetary.initialReward;

export function blockRewardAtHeight(height: number): number {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  const reward = Math.floor(INITIAL_REWARD / Math.pow(2, halvings));
  return Math.max(reward, 0);
}

/* =========================
   Coinbase Maturity
========================= */
export type PendingReward = { amount: number; unlockHeight: number };
const COINBASE_MATURITY = 33;

/* =========================
   Replay State + State Commitments + State Proofs
========================= */
export type ReplayState = {
  balances: Map<string, number>;
  nonces: Map<string, number>;
  pending: Map<string, PendingReward[]>;
  minted: number;
};

export type StateProofClaim =
  | { kind: "minted"; minted: number }
  | { kind: "balance"; address: string; balance: number }
  | { kind: "nonce"; address: string; nonce: number }
  | { kind: "pending"; address: string; index: number; amount: number; unlockHeight: number };

export type StateProof = {
  root: string;
  leafHash: string;
  claim: StateProofClaim;
  proof: MerkleProofNode[];
};

function canonicalStateObject(state: ReplayState): {
  balances: [string, number][];
  nonces: [string, number][];
  pending: [string, PendingReward[]][];
  minted: number;
} {
  const balances: [string, number][] = Array.from(state.balances.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  const nonces: [string, number][] = Array.from(state.nonces.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  const pending: [string, PendingReward[]][] = Array.from(state.pending.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([addr, arr]) => [
      addr,
      arr
        .slice()
        .sort((x, y) => x.unlockHeight - y.unlockHeight || x.amount - y.amount)
        .map((x) => ({ amount: x.amount, unlockHeight: x.unlockHeight })),
    ]);

  return {
    balances,
    nonces,
    pending,
    minted: state.minted,
  };
}

function stateLeafPayloadFromClaim(claim: StateProofClaim): string {
  switch (claim.kind) {
    case "minted":
      return `minted|${claim.minted}`;
    case "balance":
      return `balance|${claim.address}|${claim.balance}`;
    case "nonce":
      return `nonce|${claim.address}|${claim.nonce}`;
    case "pending":
      return `pending|${claim.address}|${claim.index}|${claim.unlockHeight}|${claim.amount}`;
  }
}

function stateLeafPayloads(state: ReplayState): string[] {
  const leaves: string[] = [];
  const c = canonicalStateObject(state);

  leaves.push(stateLeafPayloadFromClaim({ kind: "minted", minted: c.minted }));

  for (const [addr, bal] of c.balances) {
    leaves.push(stateLeafPayloadFromClaim({ kind: "balance", address: addr, balance: bal }));
  }

  for (const [addr, nonce] of c.nonces) {
    leaves.push(stateLeafPayloadFromClaim({ kind: "nonce", address: addr, nonce }));
  }

  for (const [addr, arr] of c.pending) {
    for (let i = 0; i < arr.length; i++) {
      const pr = arr[i];
      leaves.push(
        stateLeafPayloadFromClaim({
          kind: "pending",
          address: addr,
          index: i,
          amount: pr.amount,
          unlockHeight: pr.unlockHeight,
        })
      );
    }
  }

  leaves.sort();
  return leaves;
}

function computeStateRoot(state: ReplayState): string {
  const payloads = stateLeafPayloads(state);
  const leafHashes = payloads.map((x) => sha256(x));
  return merkleRootFromLeafHashes(leafHashes);
}

function cloneState(state: ReplayState): ReplayState {
  return {
    balances: new Map(state.balances),
    nonces: new Map(state.nonces),
    pending: new Map(Array.from(state.pending.entries()).map(([k, v]) => [k, v.slice()])),
    minted: state.minted,
  };
}

function serializeReplayState(state: ReplayState) {
  return {
    minted: state.minted,
    balances: mapToObjNum(state.balances),
    nonces: mapToObjNum(state.nonces),
    pending: pendingMapToObj(state.pending),
  };
}

function deserializeReplayState(raw: any): ReplayState {
  return {
    balances: objToMapNum(raw?.balances ?? {}),
    nonces: objToMapNum(raw?.nonces ?? {}),
    pending: pendingObjToMap(raw?.pending ?? {}),
    minted: raw?.minted ?? 0,
  };
}

function generateStateProofFromClaim(state: ReplayState, claim: StateProofClaim): StateProof | null {
  const payload = stateLeafPayloadFromClaim(claim);
  const payloads = stateLeafPayloads(state);
  if (!payloads.includes(payload)) return null;

  const leafHashes = payloads.map((x) => sha256(x));
  const leafHash = sha256(payload);
  const gp = generateMerkleProofFromLeafHash(leafHashes, leafHash);
  if (!gp) return null;

  return {
    root: gp.root,
    leafHash,
    claim,
    proof: gp.proof,
  };
}

export function verifyStateProof(sp: StateProof): boolean {
  const payload = stateLeafPayloadFromClaim(sp.claim);
  const leafHash = sha256(payload);
  if (leafHash !== sp.leafHash) return false;
  return verifyMerkleLeafProof(leafHash, sp.proof, sp.root);
}

function getBalanceProof(state: ReplayState, address: string): StateProof | null {
  const balance = state.balances.get(address);
  if (balance === undefined) return null;
  return generateStateProofFromClaim(state, { kind: "balance", address, balance });
}
function getNonceProof(state: ReplayState, address: string): StateProof | null {
  const nonce = state.nonces.get(address);
  if (nonce === undefined) return null;
  return generateStateProofFromClaim(state, { kind: "nonce", address, nonce });
}
function getMintedProof(state: ReplayState): StateProof | null {
  return generateStateProofFromClaim(state, { kind: "minted", minted: state.minted });
}
function getPendingProof(state: ReplayState, address: string, index: number): StateProof | null {
  const arr = (state.pending.get(address) ?? [])
    .slice()
    .sort((x, y) => x.unlockHeight - y.unlockHeight || x.amount - y.amount);

  if (index < 0 || index >= arr.length) return null;

  const pr = arr[index];
  return generateStateProofFromClaim(state, {
    kind: "pending",
    address,
    index,
    amount: pr.amount,
    unlockHeight: pr.unlockHeight,
  });
}

const GENESIS_EMPTY_STATE: ReplayState = {
  balances: new Map(),
  nonces: new Map(),
  pending: new Map(),
  minted: 0,
};
const GENESIS_STATE_ROOT = computeStateRoot(GENESIS_EMPTY_STATE);

/* =========================
   Limits + Fees
========================= */
export const MIN_FEE = 1;
export const MAX_BLOCK_BYTES = 250_000;
const MAX_TX_PER_BLOCK = 5000;

/* =========================
   Difficulty Adjustment (Windowed)
========================= */
export const MIN_DIFFICULTY = ACTIVE_PROFILE.difficulty.minDifficulty;
export const MAX_DIFFICULTY = ACTIVE_PROFILE.difficulty.maxDifficulty;
const TARGET_BLOCK_MS = ACTIVE_PROFILE.difficulty.targetBlockMs;
const DIFF_WINDOW = ACTIVE_PROFILE.difficulty.diffWindow;

/* =========================
   Timestamp Consensus (MTP)
========================= */
const MTP_WINDOW = 11;
const MAX_FUTURE_MS = 15 * 60_000;

function median(nums: number[]): number {
  const a = nums.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
function medianTimePast(blocks: Block[], tipIndex: number): number {
  const start = Math.max(0, tipIndex - (MTP_WINDOW - 1));
  const ts: number[] = [];
  for (let i = start; i <= tipIndex; i++) ts.push(blocks[i].ts);
  return median(ts);
}

/* =========================
   Deterministic Genesis (Committed)
========================= */
/* =========================
   Deterministic Genesis (Committed)
========================= */
const GENESIS_TS = ACTIVE_PROFILE.genesis.genesisTs;
const GENESIS_NONCE = ACTIVE_PROFILE.genesis.genesisNonce;
const GENESIS_DIFFICULTY = ACTIVE_PROFILE.genesis.genesisDifficulty;

export const GENESIS_HASH =
  ACTIVE_PROFILE.genesis.genesisHash ||
  "fb761ab1104df52d6cb55d902a19e6158d450ac7cb2756a5d0b506960d22f556";

/* =========================
   Pruning Config
========================= */
export type StorageMode = "archival" | "pruned";

export type PruneConfig = {
  enabled: boolean;
  retentionWindow: number;
  archivalMode: boolean;
};

export type StorageStats = {
  mode: StorageMode;
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
  chainstate: SeparatedChainstateStats;
  asyncDisk: AsyncDiskQueueStats;
  crashJournal: CrashJournalStats;
  chainRepair: ChainRepairStats;
};

const DEFAULT_PRUNE_RETENTION_WINDOW = 288;
const MIN_PRUNE_RETENTION_WINDOW = 64;
const MAX_PRUNE_RETENTION_WINDOW = 100_000;

export function normalizePruneConfig(raw: any): PruneConfig {
  const enabled = raw?.enabled === true;
  const archivalMode = raw?.archivalMode !== false;
  const retentionWindowRaw = isSafeInt(raw?.retentionWindow)
    ? raw.retentionWindow
    : DEFAULT_PRUNE_RETENTION_WINDOW;

  return {
    enabled,
    archivalMode,
    retentionWindow: clamp(
      retentionWindowRaw,
      MIN_PRUNE_RETENTION_WINDOW,
      MAX_PRUNE_RETENTION_WINDOW
    ),
  };
}

/* =========================
   Cumulative Work
========================= */
function workForDifficulty(diff: number): bigint {
  const bits = BigInt(4 * diff);
  return 1n << bits;
}
function chainWork(blocks: Block[]): bigint {
  let w = 0n;
  for (let i = 1; i < blocks.length; i++) w += workForDifficulty(blocks[i].difficulty);
  return w;
}

/* =========================
   Tx Model (Nonces)
========================= */
export type TxType = "TRANSFER" | "COINBASE";

export class Tx {
  id: string;
  type: TxType;
  from: string | null;
  to: string;
  amount: number;
  fee: number;
  ts: number;
  nonce: number;
  signature: string | null;

  constructor(args: {
    type: TxType;
    from: string | null;
    to: string;
    amount: number;
    fee: number;
    nonce?: number;
    ts?: number;
    signature?: string | null;
    id?: string;
  }) {
    this.type = args.type;
    this.from = args.from;
    this.to = args.to;
    this.amount = args.amount;
    this.fee = args.fee;
    this.nonce = args.nonce ?? 0;
    this.ts = args.ts ?? now();
    this.signature = args.signature ?? null;
    this.id = args.id ?? this.computeId();
  }

  payload() {
    return JSON.stringify({
      chainId: CHAIN_ID,
      version: PROTOCOL_VERSION,
      type: this.type,
      from: this.from,
      to: this.to,
      amount: this.amount,
      fee: this.fee,
      nonce: this.nonce,
      ts: this.ts,
    });
  }

  computeId() {
    return sha256(this.payload());
  }

  sign(privateKeyPem: string) {
    if (!this.from) throw new Error("Cannot sign without from");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(this.payload());
    sign.end();
    this.signature = sign.sign(privateKeyPem).toString("base64");
    this.id = this.computeId();
  }

  verify(): boolean {
    if (this.type === "COINBASE") return true;
    if (!this.from || !this.signature) return false;
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(this.payload());
    verifier.end();
    return verifier.verify(this.from, Buffer.from(this.signature, "base64"));
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      from: this.from,
      to: this.to,
      amount: this.amount,
      fee: this.fee,
      nonce: this.nonce,
      ts: this.ts,
      signature: this.signature,
    };
  }

  static fromJSON(j: any) {
    return new Tx({
      id: j.id,
      type: j.type,
      from: j.from,
      to: j.to,
      amount: j.amount,
      fee: j.fee,
      nonce: j.nonce ?? 0,
      ts: j.ts,
      signature: j.signature ?? null,
    });
  }
}

/* =========================
   Mempool Relay Policy Hardening + Eviction Policy
========================= */
export const DEFAULT_MIN_RELAY_FEE = 2;
export const MEMPOOL_MIN_BYTES = 100;
export const MEMPOOL_MAX_BYTES = 50_000;
export const MAX_MEMPOOL_TXS = 10_000;
export const MAX_MEMPOOL_TXS_PER_SENDER = 128;

export type MempoolPolicyDecision = {
  ok: boolean;
  reason?: string;
  txBytes: number;
  minRelayFee: number;
};

export type MempoolEvictionReason =
  | "none"
  | "mempool-full"
  | "sender-full"
  | "low-fee-rate"
  | "nonce-chain";

export type MempoolEvictionCandidate = {
  txId: string;
  from: string;
  nonce: number;
  fee: number;
  amount: number;
  txBytes: number;
  feeRate: number;
  descendantCount: number;
  packageTxIds: string[];
  packageFees: number;
  packageBytes: number;
  packageFeeRate: number;
};

export type MempoolAdmissionResult = {
  ok: boolean;
  reason?: string;
  txId: string;
  txBytes: number;
  feeRate: number;
  mempoolSizeBefore: number;
  mempoolSizeAfter: number;
  evicted: MempoolEvictionCandidate[];
};

export type MempoolStats = {
  size: number;
  maxSize: number;
  senderCount: number;
  maxPerSender: number;
  totalBytes: number;
  minFeeRate: number | null;
  maxFeeRate: number | null;
  avgFeeRate: number | null;
  lowestTx: MempoolEvictionCandidate | null;
};

export function txRelayBytes(tx: Tx): number {
  const raw = approxBytes(tx.toJSON());
  return clamp(raw, 0, Number.MAX_SAFE_INTEGER);
}

export function minRelayFeeForTxBytes(bytes: number): number {
  const safeBytes = clamp(Math.floor(Number.isFinite(bytes) ? bytes : 0), 0, Number.MAX_SAFE_INTEGER);
  const kb = Math.max(1, Math.ceil(safeBytes / 1000));
  return kb * DEFAULT_MIN_RELAY_FEE;
}

export function minRelayFeeForTx(tx: Tx): number {
  return minRelayFeeForTxBytes(txRelayBytes(tx));
}

function txFeeRate(tx: Tx): number {
  const bytes = Math.max(1, txRelayBytes(tx));
  return tx.fee / bytes;
}

function compareTxPriority(a: Tx, b: Tx): number {
  const feeRateDelta = txFeeRate(b) - txFeeRate(a);
  if (feeRateDelta !== 0) return feeRateDelta > 0 ? 1 : -1;

  const feeDelta = b.fee - a.fee;
  if (feeDelta !== 0) return feeDelta;

  return txRelayBytes(a) - txRelayBytes(b);
}

function compareTxWeakness(a: Tx, b: Tx): number {
  const feeRateDelta = txFeeRate(a) - txFeeRate(b);
  if (feeRateDelta !== 0) return feeRateDelta < 0 ? -1 : 1;

  const feeDelta = a.fee - b.fee;
  if (feeDelta !== 0) return feeDelta;

  return txRelayBytes(b) - txRelayBytes(a);
}

/* =========================
   Block Model + Header Hash
========================= */
export type BlockHeader = {
  hash: string;
  prevHash: string;
  ts: number;
  nonce: number;
  difficulty: number;
  txRoot: string;
  stateRoot: string;
};

export type SnapshotCheckpoint = {
  height: number;
  tipHash: string;
  stateRoot: string;
  state: ReplayState;
};

export type SnapshotImportJson = {
  height: number;
  tipHash: string;
  stateRoot: string;
  minted: number;
  balances: Record<string, number>;
  nonces: Record<string, number>;
  pending: Record<string, PendingReward[]>;
  createdAt?: number;
};

export function computeHeaderHashFromFields(h: {
  prevHash: string;
  ts: number;
  nonce: number;
  difficulty: number;
  txRoot: string;
  stateRoot: string;
}): string {
  const s = JSON.stringify({
    chainId: CHAIN_ID,
    version: PROTOCOL_VERSION,
    prevHash: h.prevHash,
    ts: h.ts,
    nonce: h.nonce,
    difficulty: h.difficulty,
    txRoot: h.txRoot,
    stateRoot: h.stateRoot,
  });
  return sha256(s);
}
export function computeHeaderHash(h: BlockHeader): string {
  return computeHeaderHashFromFields({
    prevHash: h.prevHash,
    ts: h.ts,
    nonce: h.nonce,
    difficulty: h.difficulty,
    txRoot: h.txRoot,
    stateRoot: h.stateRoot,
  });
}

export class Block {
  prevHash: string;
  ts: number;
  nonce: number;
  difficulty: number;
  txs: Tx[];
  stateRoot: string;
  hash: string;

  constructor(args: {
    prevHash: string;
    difficulty: number;
    txs: Tx[];
    stateRoot?: string;
    ts?: number;
    nonce?: number;
    hash?: string;
  }) {
    this.prevHash = args.prevHash;
    this.ts = args.ts ?? now();
    this.nonce = args.nonce ?? 0;
    this.difficulty = args.difficulty;
    this.txs = args.txs;
    this.stateRoot = args.stateRoot ?? GENESIS_STATE_ROOT;
    this.hash = args.hash ?? this.computeHash();
  }

  header() {
    return JSON.stringify({
      chainId: CHAIN_ID,
      version: PROTOCOL_VERSION,
      prevHash: this.prevHash,
      ts: this.ts,
      nonce: this.nonce,
      difficulty: this.difficulty,
      txRoot: merkleRootForBlockTxs(this.txs),
      stateRoot: this.stateRoot,
    });
  }

  headerObj(): BlockHeader {
    const txRoot = merkleRootForBlockTxs(this.txs);
    return {
      hash: this.hash,
      prevHash: this.prevHash,
      ts: this.ts,
      nonce: this.nonce,
      difficulty: this.difficulty,
      txRoot,
      stateRoot: this.stateRoot,
    };
  }

  computeHash() {
    return sha256(this.header());
  }

  mine() {
    const target = "0".repeat(this.difficulty);
    while (true) {
      this.hash = this.computeHash();
      if (this.hash.startsWith(target)) return;
      this.nonce++;
    }
  }

  async mineAsync(
    yieldEveryNonces = 20_000,
    onProgress?: (progress: {
      nonce: number;
      attempts: number;
      elapsedMs: number;
      hashRate: number;
      hash: string;
    }) => void,
    shouldCancel?: () => boolean
  ): Promise<boolean> {
    const target = "0".repeat(this.difficulty);
    const startedAt = Date.now();
    let ctr = 0;
    let attempts = 0;

    while (true) {
      if (shouldCancel?.()) {
        return false;
      }

      this.hash = this.computeHash();
      attempts++;

      if (this.hash.startsWith(target)) {
        const elapsedMs = Math.max(1, Date.now() - startedAt);

        onProgress?.({
          nonce: this.nonce,
          attempts,
          elapsedMs,
          hashRate: Math.round((attempts * 1000) / elapsedMs),
          hash: this.hash,
        });

        return true;
      }

      this.nonce++;
      ctr++;

      if (ctr >= yieldEveryNonces) {
        const elapsedMs = Math.max(1, Date.now() - startedAt);

        onProgress?.({
          nonce: this.nonce,
          attempts,
          elapsedMs,
          hashRate: Math.round((attempts * 1000) / elapsedMs),
          hash: this.hash,
        });

        ctr = 0;
        await tick();

        if (shouldCancel?.()) {
          return false;
        }
      }
    }
  }

  toJSON() {
    return {
      prevHash: this.prevHash,
      ts: this.ts,
      nonce: this.nonce,
      difficulty: this.difficulty,
      stateRoot: this.stateRoot,
      txs: this.txs.map((t) => t.toJSON()),
      hash: this.hash,
    };
  }

  static fromJSON(j: any) {
    return new Block({
      prevHash: j.prevHash,
      ts: j.ts,
      nonce: j.nonce,
      difficulty: j.difficulty,
      stateRoot: j.stateRoot,
      txs: (j.txs ?? []).map((x: any) => Tx.fromJSON(x)),
      hash: j.hash,
    });
  }
}

/* =========================
   Validation helpers
========================= */
function getMapNum(m: Map<string, number>, k: string) {
  return m.get(k) ?? 0;
}
function setMapNum(m: Map<string, number>, k: string, v: number) {
  m.set(k, v);
}
function mapToObjNum(m: Map<string, number>) {
  const o: Record<string, number> = {};
  for (const [k, v] of m.entries()) o[k] = v;
  return o;
}
function objToMapNum(o: Record<string, number>) {
  const m = new Map<string, number>();
  for (const k of Object.keys(o)) m.set(k, o[k]);
  return m;
}
function pendingMapToObj(p: Map<string, PendingReward[]>) {
  const o: Record<string, PendingReward[]> = {};
  for (const [k, v] of p.entries()) o[k] = v.map((x) => ({ amount: x.amount, unlockHeight: x.unlockHeight }));
  return o;
}
function pendingObjToMap(o: Record<string, PendingReward[]>) {
  const m = new Map<string, PendingReward[]>();
  for (const k of Object.keys(o)) {
    m.set(
      k,
      (o[k] ?? []).map((x) => ({ amount: x.amount, unlockHeight: x.unlockHeight }))
    );
  }
  return m;
}

function computeFees(block: Block): number {
  let fees = 0;
  for (let i = 1; i < block.txs.length; i++) fees += block.txs[i].fee;
  return fees;
}

function unlockMaturedRewards(state: ReplayState, height: number) {
  for (const [addr, arr] of state.pending.entries()) {
    const keep: PendingReward[] = [];
    for (const pr of arr) {
      if (pr.unlockHeight <= height) {
        setMapNum(state.balances, addr, getMapNum(state.balances, addr) + pr.amount);
      } else {
        keep.push(pr);
      }
    }
    if (keep.length) state.pending.set(addr, keep);
    else state.pending.delete(addr);
  }
}

function validateTimestamp(ts: number, prevBlockTs: number, mtp: number) {
  if (!isSafeInt(ts) || ts <= 0) return { ok: false, reason: "bad ts" };
  if (ts > now() + MAX_FUTURE_MS) return { ok: false, reason: "too future" };
  if (ts <= mtp) return { ok: false, reason: "ts <= median-time-past" };
  if (ts < prevBlockTs) return { ok: false, reason: "ts < prevBlockTs" };
  return { ok: true as const };
}

function validateBlockHeaderOnly(
  block: Block,
  prevHash: string,
  prevBlockTs: number,
  mtp: number
): { ok: boolean; reason?: string } {
  if (block.prevHash !== prevHash) return { ok: false, reason: "bad prevHash" };
  if (!block.hash.startsWith("0".repeat(block.difficulty))) return { ok: false, reason: "bad pow" };
  if (block.hash !== block.computeHash()) return { ok: false, reason: "bad hash" };

  const tsOk = validateTimestamp(block.ts, prevBlockTs, mtp);
  if (!tsOk.ok) return { ok: false, reason: tsOk.reason };

  return { ok: true };
}

function applyBlockBodyToState(
  state: ReplayState,
  block: Block,
  height: number
): { ok: boolean; reason?: string } {
  if (!block.txs.length) return { ok: false, reason: "no txs" };
  const cb = block.txs[0];
  if (cb.type !== "COINBASE") return { ok: false, reason: "tx0 not coinbase" };
  if (cb.from !== null) return { ok: false, reason: "coinbase from not null" };

  unlockMaturedRewards(state, height);

  const fees = computeFees(block);
  const subsidy = blockRewardAtHeight(height);
  const expectedCb = subsidy + fees;
  if (cb.amount !== expectedCb) return { ok: false, reason: "bad coinbase amount" };

  const unlockHeight = height + COINBASE_MATURITY;
  const arr = state.pending.get(cb.to) ?? [];
  arr.push({ amount: cb.amount, unlockHeight });
  state.pending.set(cb.to, arr);

  if (subsidy > 0) {
    state.minted += subsidy;
    if (state.minted > MAX_SUPPLY) return { ok: false, reason: "max supply exceeded" };
  }

  for (let i = 1; i < block.txs.length; i++) {
    const t = block.txs[i];
    if (t.type !== "TRANSFER") return { ok: false, reason: "non-transfer in body" };
    if (!t.verify()) return { ok: false, reason: "bad sig" };
    if (!t.from) return { ok: false, reason: "missing from" };
    if (!isSafeInt(t.amount) || t.amount <= 0) return { ok: false, reason: "bad amount" };
    if (!isSafeInt(t.fee) || t.fee < MIN_FEE) return { ok: false, reason: "fee too low" };

    const confirmed = getMapNum(state.nonces, t.from);
    const want = confirmed + 1;
    if (t.nonce !== want) return { ok: false, reason: `bad nonce (want ${want})` };

    const need = t.amount + t.fee;
    const bal = getMapNum(state.balances, t.from);
    if (bal < need) return { ok: false, reason: "insufficient funds" };

    setMapNum(state.balances, t.from, bal - need);
    setMapNum(state.balances, t.to, getMapNum(state.balances, t.to) + t.amount);
    setMapNum(state.nonces, t.from, want);
  }

  return { ok: true };
}

function computePostStateForBlock(
  baseState: ReplayState,
  block: Block,
  height: number,
  prevHash: string,
  prevBlockTs: number,
  mtp: number,
  checkHeader = true
): { ok: boolean; reason?: string; state?: ReplayState; stateRoot?: string } {
  const st = cloneState(baseState);

  if (checkHeader) {
    const headerOk = validateBlockHeaderOnly(block, prevHash, prevBlockTs, mtp);
    if (!headerOk.ok) return { ok: false, reason: headerOk.reason };
  }

  const bodyOk = applyBlockBodyToState(st, block, height);
  if (!bodyOk.ok) return { ok: false, reason: bodyOk.reason };

  unlockMaturedRewards(st, height);
  return { ok: true, state: st, stateRoot: computeStateRoot(st) };
}

function replayValidateChain(blocks: Block[]) {
  const state: ReplayState = { balances: new Map(), nonces: new Map(), pending: new Map(), minted: 0 };

  const g = blocks[0];
  if (g.prevHash !== "") return { ok: false, reason: "genesis prevHash not empty" };
  if (g.ts !== GENESIS_TS) return { ok: false, reason: "genesis ts mismatch" };
  if (g.nonce !== GENESIS_NONCE) return { ok: false, reason: "genesis nonce mismatch" };
  if (g.difficulty !== GENESIS_DIFFICULTY) return { ok: false, reason: "genesis difficulty mismatch" };
  if (g.txs.length !== 0) return { ok: false, reason: "genesis txs not empty" };
  if (g.stateRoot !== GENESIS_STATE_ROOT) return { ok: false, reason: "genesis stateRoot mismatch" };
  if (g.hash !== GENESIS_HASH) return { ok: false, reason: "genesis hash mismatch" };
  if (g.hash !== g.computeHash()) return { ok: false, reason: "genesis hash not deterministic" };

  let prevHash = g.hash;

  for (let i = 1; i < blocks.length; i++) {
    const prevTs = blocks[i - 1].ts;
    const mtp = medianTimePast(blocks, i - 1);
    const post = computePostStateForBlock(state, blocks[i], i, prevHash, prevTs, mtp, true);
    if (!post.ok || !post.state || !post.stateRoot) return { ok: false, reason: `block#${i} ${post.reason}` };
    if (blocks[i].stateRoot !== post.stateRoot) return { ok: false, reason: `block#${i} bad stateRoot` };

    state.balances = post.state.balances;
    state.nonces = post.state.nonces;
    state.pending = post.state.pending;
    state.minted = post.state.minted;
    prevHash = blocks[i].hash;
  }

  return { ok: true, state };
}

function replayValidateChainFromState(
  blocks: Block[],
  startHeight: number,
  baseState: ReplayState,
  checkpointHeight = 0
): { ok: boolean; reason?: string; state?: ReplayState } {
  if (startHeight <= 0) return replayValidateChain(blocks);
  if (startHeight >= blocks.length) return { ok: true, state: cloneState(baseState) };

  const prevBlock = blocks[startHeight - 1];
  const expectedBaseRoot = computeStateRoot(baseState);
  if (prevBlock.stateRoot !== expectedBaseRoot) {
    return { ok: false, reason: `snapshot stateRoot mismatch at block#${checkpointHeight + startHeight - 1}` };
  }

  const state = cloneState(baseState);
  let prevHash = prevBlock.hash;

  for (let i = startHeight; i < blocks.length; i++) {
    const prevTs = blocks[i - 1].ts;
    const mtp = medianTimePast(blocks, i - 1);
    const absHeight = checkpointHeight + i;
    const post = computePostStateForBlock(state, blocks[i], absHeight, prevHash, prevTs, mtp, true);
    if (!post.ok || !post.state || !post.stateRoot) return { ok: false, reason: `block#${absHeight} ${post.reason}` };
    if (blocks[i].stateRoot !== post.stateRoot) return { ok: false, reason: `block#${absHeight} bad stateRoot` };

    state.balances = post.state.balances;
    state.nonces = post.state.nonces;
    state.pending = post.state.pending;
    state.minted = post.state.minted;
    prevHash = blocks[i].hash;
  }

  return { ok: true, state };
}

/* =========================
   Snapshot + Reorg helpers
========================= */
const SNAPSHOT_EVERY = 50;

type Snapshot = {
  height: number;
  tipHash: string;
  minted: number;
  balances: Record<string, number>;
  nonces: Record<string, number>;
  pending: Record<string, PendingReward[]>;
};

type LoadedSnapshot = {
  height: number;
  tipHash: string;
  state: ReplayState;
};

function snapshotFileFor(chainFile: string) {
  return chainFile.replace(/\.json$/, "") + `.snapshot.json`;
}

function snapshotBackupFileFor(chainFile: string) {
  return backupFileFor(snapshotFileFor(chainFile));
}

function snapshotToState(snap: Snapshot): ReplayState {
  return {
    balances: objToMapNum(snap.balances ?? {}),
    nonces: objToMapNum(snap.nonces ?? {}),
    pending: pendingObjToMap(snap.pending ?? {}),
    minted: snap.minted ?? 0,
  };
}
function validateLoadedSnapshot(
  blocks: Block[],
  snap: Snapshot,
  checkpointHeight = 0
): { ok: boolean; reason?: string; loaded?: LoadedSnapshot } {
  const localHeight = snap.height - checkpointHeight;
  if (!isSafeInt(snap.height) || snap.height < checkpointHeight || localHeight < 0 || localHeight >= blocks.length) {
    return { ok: false, reason: "snapshot height out of range" };
  }
  if (typeof snap.tipHash !== "string" || !snap.tipHash) {
    return { ok: false, reason: "snapshot missing tipHash" };
  }
  if (blocks[localHeight].hash !== snap.tipHash) {
    return { ok: false, reason: "snapshot tipHash mismatch" };
  }

  const state = snapshotToState(snap);
  const root = computeStateRoot(state);
  if (blocks[localHeight].stateRoot !== root) {
    return { ok: false, reason: "snapshot stateRoot mismatch" };
  }

  return {
    ok: true,
    loaded: {
      height: snap.height,
      tipHash: snap.tipHash,
      state,
    },
  };
}

function undoBlockFromState(state: ReplayState, block: Block, height: number) {
  for (let i = block.txs.length - 1; i >= 1; i--) {
    const t = block.txs[i];
    if (t.type !== "TRANSFER") continue;

    const need = t.amount + t.fee;
    setMapNum(state.balances, t.from!, getMapNum(state.balances, t.from!) + need);
    setMapNum(state.balances, t.to, getMapNum(state.balances, t.to) - t.amount);

    const cur = getMapNum(state.nonces, t.from!);
    setMapNum(state.nonces, t.from!, Math.max(0, cur - 1));
  }

  const cb = block.txs[0];
  const fees = computeFees(block);
  const subsidy = Math.max(0, cb.amount - fees);

  const unlockHeight = height + COINBASE_MATURITY;
  const arr = state.pending.get(cb.to) ?? [];
  let removed = false;
  const nextArr: PendingReward[] = [];
  for (const pr of arr) {
    if (!removed && pr.amount === cb.amount && pr.unlockHeight === unlockHeight) {
      removed = true;
      continue;
    }
    nextArr.push(pr);
  }
  if (nextArr.length) state.pending.set(cb.to, nextArr);
  else state.pending.delete(cb.to);

  if (subsidy > 0) state.minted = Math.max(0, state.minted - subsidy);
}

/* =========================
   Chain (Layer1)
========================= */
const MAX_ORPHAN_BLOCKS = 256;
const ORPHAN_TTL_MS = 120_000;
const ORPHAN_PROCESS_BUDGET = 512;

export class Chain {
  static instance = new Chain();

  blocks: Block[] = [];
  mempool = new Map<string, Tx>();

  mempoolReserved = new Map<string, number>();
  mempoolNextNonce = new Map<string, number>();

  orphanBlocks = new Map<string, Block>();
  orphanOrder: string[] = [];
  orphanReceivedAt = new Map<string, number>();
  orphansByPrev = new Map<string, Set<string>>();

  chainFile = "dubzchain.json";
  private stateCache: ReplayState | null = null;
  private checkpoint: SnapshotCheckpoint | null = null;
  private pruneConfig: PruneConfig = normalizePruneConfig(null);

  constructor() {
    const genesis = new Block({
      prevHash: "",
      difficulty: GENESIS_DIFFICULTY,
      txs: [],
      stateRoot: GENESIS_STATE_ROOT,
      ts: GENESIS_TS,
      nonce: GENESIS_NONCE,
    });

    const computed = genesis.computeHash();
    if (computed !== GENESIS_HASH) {
      throw new Error(`Genesis commitment mismatch! computed=${computed} expected=${GENESIS_HASH}`);
    }
    genesis.hash = GENESIS_HASH;
    this.blocks = [genesis];
  }

  private clearCheckpoint() {
    this.checkpoint = null;
  }

  private buildChainstateJsonFromState(state: ReplayState) {
    const tip = this.blocks[this.blocks.length - 1];
    const records = mapsToChainstateRecords({
      balances: state.balances,
      nonces: state.nonces,
      pending: state.pending,
    });

    const existing = loadChainstate(this.chainFile);
    const previousCreatedAt = existing.ok ? existing.data.createdAt : undefined;

    return makeChainstateJson({
      chainId: CHAIN_ID,
      protocolVersion: PROTOCOL_VERSION,
      height: this.height(),
      tipHash: tip.hash,
      stateRoot: tip.stateRoot,
      minted: state.minted,
      balances: records.balances,
      nonces: records.nonces,
      pending: records.pending,
      previousCreatedAt,
    });
  }

  private saveChainstateNow(reason = "save") {
    try {
      const state = this.getState();
      const data = this.buildChainstateJsonFromState(state);
      const file = chainstateFileFor(this.chainFile);
      const backupFile = chainstateBackupFileFor(this.chainFile);
      const bytes = Buffer.byteLength(JSON.stringify(data, null, 2), "utf8");

      asyncDiskQueue.writeJson(file, data, backupFile);

      console.log(
        `🧠 chainstate write queued | reason=${reason} | height=${data.height} | bytes=${bytes} | file=${file}`
      );
      return true;
    } catch (e: any) {
      console.log(`⚠️ chainstate queue failed | reason=${e?.message ?? String(e)}`);
      return false;
    }
  }

  private loadSeparatedChainstateForBlocks(blocks: Block[]): ReplayState | null {
    const loaded = loadChainstate(this.chainFile);
    if (!loaded.ok) {
      const badLoad = loaded as { ok: false; file: string; reason: string; error?: string };
      if (badLoad.reason !== "missing") {
        console.log(`⚠️ chainstate ignored ${badLoad.file} | reason=${badLoad.reason}${badLoad.error ? ` | ${badLoad.error}` : ""}`);
      }
      return null;
    }

    const tip = blocks[blocks.length - 1];
    const expectedHeight = this.checkpoint ? this.checkpoint.height + (blocks.length - 1) : blocks.length - 1;

    if (loaded.data.chainId !== CHAIN_ID || loaded.data.protocolVersion !== PROTOCOL_VERSION) {
      console.log(`⚠️ chainstate ignored ${loaded.file} | reason=identity-mismatch`);
      return null;
    }
    if (loaded.data.height !== expectedHeight) {
      console.log(
        `⚠️ chainstate ignored ${loaded.file} | reason=height-mismatch got=${loaded.data.height} want=${expectedHeight}`
      );
      return null;
    }
    if (loaded.data.tipHash !== tip.hash) {
      console.log(`⚠️ chainstate ignored ${loaded.file} | reason=tipHash-mismatch`);
      return null;
    }
    if (loaded.data.stateRoot !== tip.stateRoot) {
      console.log(`⚠️ chainstate ignored ${loaded.file} | reason=stateRoot-mismatch`);
      return null;
    }

    const maps = chainstateToMaps(loaded.data);
    const state: ReplayState = {
      balances: maps.balances,
      nonces: maps.nonces,
      pending: maps.pending,
      minted: maps.minted,
    };

    const computedRoot = computeStateRoot(state);
    if (computedRoot !== tip.stateRoot) {
      console.log(`⚠️ chainstate ignored ${loaded.file} | reason=computed-stateRoot-mismatch`);
      return null;
    }

    console.log(
      `🧠 chainstate restore ${loaded.file} | loadedFrom=${loaded.loadedFrom} | height=${loaded.data.height} | balances=${Object.keys(loaded.data.balances).length} | pendingAccounts=${Object.keys(loaded.data.pending).length}`
    );

    return state;
  }

  private loadCheckpointFromChainFile(raw: any, blocks: Block[]): boolean {
    const cp = raw?.checkpoint;
    if (!cp || typeof cp !== "object") return false;
    if (!isSafeInt(cp.height) || cp.height < 0) return false;
    if (typeof cp.tipHash !== "string" || !cp.tipHash) return false;
    if (typeof cp.stateRoot !== "string" || !cp.stateRoot) return false;
    if (!cp.state || typeof cp.state !== "object") return false;
    if (!blocks.length) return false;
    if (blocks[0].hash !== cp.tipHash) return false;
    if (blocks[0].stateRoot !== cp.stateRoot) return false;

    const state = deserializeReplayState(cp.state);
    const computedRoot = computeStateRoot(state);
    if (computedRoot !== cp.stateRoot) return false;

    this.checkpoint = {
      height: cp.height,
      tipHash: cp.tipHash,
      stateRoot: cp.stateRoot,
      state,
    };
    return true;
  }

  private computeStateAtLocalIndex(localIndex: number): ReplayState {
    if (localIndex < 0 || localIndex >= this.blocks.length) {
      throw new Error(`state index out of range: ${localIndex}`);
    }

    if (this.checkpoint) {
      if (localIndex === 0) return cloneState(this.checkpoint.state);

      const res = replayValidateChainFromState(
        this.blocks.slice(0, localIndex + 1),
        1,
        this.checkpoint.state,
        this.checkpoint.height
      );
      if (!res.ok || !res.state) throw new Error(`checkpoint prefix invalid: ${res.reason ?? "unknown"}`);
      return cloneState(res.state);
    }

    const res = replayValidateChain(this.blocks.slice(0, localIndex + 1));
    if (!res.ok || !res.state) throw new Error(`prefix invalid: ${res.reason ?? "unknown"}`);
    return cloneState(res.state);
  }

  private maybePruneOldBlocks(): boolean {
    if (!this.pruningEnabled()) return false;
    if (!this.stateCache) return false;

    const absHeight = this.height();
    const retention = this.pruneRetentionWindow();

    if (absHeight <= retention) return false;

    const currentBaseHeight = this.checkpoint ? this.checkpoint.height : 0;
    const pruneToHeight = absHeight - retention;

    if (pruneToHeight <= currentBaseHeight) return false;

    const pruneLocalIndex = pruneToHeight - currentBaseHeight;
    if (pruneLocalIndex <= 0 || pruneLocalIndex >= this.blocks.length) return false;

    const pruneBlock = this.blocks[pruneLocalIndex];
    const pruneState = this.computeStateAtLocalIndex(pruneLocalIndex);

    const oldBase = currentBaseHeight;
    const oldLocalBlocks = this.blocks.length;

    const anchor = new Block({
      prevHash: "",
      difficulty: pruneBlock.difficulty,
      txs: [],
      stateRoot: pruneBlock.stateRoot,
      ts: GENESIS_TS,
      nonce: GENESIS_NONCE,
      hash: pruneBlock.hash,
    });

    const retainedTail = this.blocks.slice(pruneLocalIndex + 1);

    this.checkpoint = {
      height: pruneToHeight,
      tipHash: pruneBlock.hash,
      stateRoot: pruneBlock.stateRoot,
      state: pruneState,
    };

    this.blocks = [anchor, ...retainedTail];

    const stats = this.getStorageStats();
    console.log(
      `🧹 pruned local blocks | oldBase=${oldBase} | newBase=${pruneToHeight} | pruned=${pruneLocalIndex} | retainedLocal=${this.blocks.length} | oldLocal=${oldLocalBlocks} | mode=${stats.mode} | fullHeight=${stats.fullHeight}`
    );

    return true;
  }

  private pruneExpiredOrphans(): number {
    if (this.orphanBlocks.size === 0) return 0;

    const cutoff = now() - ORPHAN_TTL_MS;
    let removed = 0;

    for (const hash of this.orphanOrder.slice()) {
      const seenAt = this.orphanReceivedAt.get(hash) ?? 0;
      if (seenAt > cutoff) continue;
      this.removeOrphanSubtree(hash);
      removed++;
    }

    if (removed > 0) {
      console.log(`🧹 pruned expired orphans count=${removed} remaining=${this.orphanCount()}`);
    }

    return removed;
  }

  private pruneDanglingOrphans(): number {
    if (this.orphanBlocks.size === 0) return 0;

    let removed = 0;

    for (const [hash, blk] of Array.from(this.orphanBlocks.entries())) {
      if (this.chainHasHash(hash)) {
        this.removeOrphanSubtree(hash);
        removed++;
        continue;
      }

      if (this.chainHasHash(blk.prevHash)) continue;
      if (this.orphanBlocks.has(blk.prevHash)) continue;

      this.removeOrphanSubtree(hash);
      removed++;
    }

    if (removed > 0) {
      console.log(`🧹 pruned dangling orphans count=${removed} remaining=${this.orphanCount()}`);
    }

    return removed;
  }

  private pruneOrphans() {
    this.pruneExpiredOrphans();
    this.pruneDanglingOrphans();

    while (this.orphanBlocks.size > MAX_ORPHAN_BLOCKS) {
      this.evictOldestOrphan();
    }
  }

  getPruneConfig(): PruneConfig {
    return {
      enabled: this.pruneConfig.enabled,
      retentionWindow: this.pruneConfig.retentionWindow,
      archivalMode: this.pruneConfig.archivalMode,
    };
  }

  getStorageMode(): StorageMode {
    return this.pruneConfig.archivalMode ? "archival" : "pruned";
  }

  getStorageStats(): StorageStats {
    const cpHeight = this.checkpoint?.height ?? 0;
    const localBlocks = this.blocks.length;
    const fullHeight = this.height();
    const retainedTailBlocks = Math.max(0, localBlocks - 1);
    const prunedBlockCountEstimate = cpHeight;

    return {
      mode: this.getStorageMode(),
      pruningEnabled: this.pruningEnabled(),
      archivalMode: this.archivalMode(),
      retentionWindow: this.pruneRetentionWindow(),
      checkpointHeight: cpHeight,
      checkpointTipHash: this.checkpointTipHash(),
      hasCheckpoint: this.hasCheckpoint(),
      localBlocks,
      retainedTailBlocks,
      fullHeight,
      prunedBlockCountEstimate,
      tipHash: this.tipHash(),
      chainstate: getChainstateStats(this.chainFile),
      asyncDisk: getAsyncDiskQueueStats(),
      crashJournal: getCrashJournalStats(this.chainFile),
      chainRepair: getChainRepairStats(this.chainFile),
    };
  }

  logStorageStats(prefix = "🧹 storage stats") {
    const s = this.getStorageStats();
    console.log(
      `${prefix} | mode=${s.mode} | pruningEnabled=${s.pruningEnabled} | retentionWindow=${s.retentionWindow} | checkpointHeight=${s.checkpointHeight} | localBlocks=${s.localBlocks} | retainedTail=${s.retainedTailBlocks} | fullHeight=${s.fullHeight} | prunedEstimate=${s.prunedBlockCountEstimate}`
    );
  }

  setPruneConfig(raw: Partial<PruneConfig>) {
    const merged = normalizePruneConfig({
      ...this.pruneConfig,
      ...raw,
    });
    this.pruneConfig = merged;
    this.logStorageStats("🧹 prune config updated");
    this.save();
  }

  setStorageMode(mode: StorageMode, retentionWindow?: number) {
    if (mode === "archival") {
      this.pruneConfig = normalizePruneConfig({
        ...this.pruneConfig,
        enabled: false,
        archivalMode: true,
        retentionWindow:
          retentionWindow ?? this.pruneConfig.retentionWindow ?? DEFAULT_PRUNE_RETENTION_WINDOW,
      });
    } else {
      this.pruneConfig = normalizePruneConfig({
        ...this.pruneConfig,
        enabled: true,
        archivalMode: false,
        retentionWindow:
          retentionWindow ?? this.pruneConfig.retentionWindow ?? DEFAULT_PRUNE_RETENTION_WINDOW,
      });
    }

    this.logStorageStats("🧹 storage mode switched");
    this.save();
  }

  enableArchivalMode() {
    this.setStorageMode("archival");
  }

  enablePrunedMode(retentionWindow?: number) {
    this.setStorageMode("pruned", retentionWindow);
  }

  pruningEnabled() {
    return this.pruneConfig.enabled && !this.pruneConfig.archivalMode;
  }

  pruneRetentionWindow() {
    return this.pruneConfig.retentionWindow;
  }

  archivalMode() {
    return this.pruneConfig.archivalMode;
  }

  hasCheckpoint() {
    return this.checkpoint !== null;
  }

  checkpointHeight() {
    return this.checkpoint?.height ?? 0;
  }

  checkpointTipHash() {
    return this.checkpoint?.tipHash ?? this.blocks[0]?.hash ?? GENESIS_HASH;
  }

  height() {
    return this.checkpoint ? this.checkpoint.height + (this.blocks.length - 1) : this.blocks.length - 1;
  }

  tipHash() {
    return this.blocks[this.blocks.length - 1].hash;
  }

  exportHeaders(): BlockHeader[] {
    return this.blocks.map((b) => b.headerObj());
  }

  exportBlockRange(fromHeight: number, maxCount: number): any[] {
    const from = Math.max(0, fromHeight);
    const start = this.checkpoint ? this.checkpoint.height : 0;
    const localFrom = Math.max(0, from - start);
    const to = Math.min(this.blocks.length, localFrom + Math.max(1, maxCount));
    const out: any[] = [];
    for (let i = localFrom; i < to; i++) out.push(this.blocks[i].toJSON());
    return out;
  }

  orphanCount() {
    this.pruneOrphans();
    return this.orphanBlocks.size;
  }

  getState(): ReplayState {
    if (!this.stateCache) return this.rebuildState();
    return this.stateCache;
  }

  rebuildState(): ReplayState {
    if (this.checkpoint) {
      const res = replayValidateChainFromState(this.blocks, 1, this.checkpoint.state, this.checkpoint.height);
      if (!res.ok || !res.state) throw new Error(`Checkpoint chain invalid: ${res.reason ?? "unknown"}`);
      this.stateCache = res.state;
      return this.stateCache;
    }

    const res = replayValidateChain(this.blocks);
    if (!res.ok || !res.state) throw new Error(`Chain invalid: ${res.reason ?? "unknown"}`);
    this.stateCache = res.state;
    return this.stateCache;
  }

  getBalanceProof(pubKey: string) {
    return getBalanceProof(this.getState(), pubKey);
  }
  getNonceProof(pubKey: string) {
    return getNonceProof(this.getState(), pubKey);
  }
  getPendingProof(pubKey: string, index: number) {
    return getPendingProof(this.getState(), pubKey, index);
  }
  getMintedProof() {
    return getMintedProof(this.getState());
  }

  relayBytesForTx(tx: Tx) {
    return txRelayBytes(tx);
  }

  relayFeeForTx(tx: Tx) {
    return minRelayFeeForTx(tx);
  }

  private mempoolSenderCount(pubKey: string): number {
    let n = 0;
    for (const t of this.mempool.values()) {
      if (t.from === pubKey) n++;
    }
    return n;
  }

  assessMempoolPolicy(tx: Tx): MempoolPolicyDecision {
    const txBytes = txRelayBytes(tx);
    const minRelayFee = minRelayFeeForTxBytes(txBytes);

    if (txBytes < MEMPOOL_MIN_BYTES || txBytes > MEMPOOL_MAX_BYTES) {
      return {
        ok: false,
        reason: `bad-size txBytes=${txBytes} minBytes=${MEMPOOL_MIN_BYTES} maxBytes=${MEMPOOL_MAX_BYTES}`,
        txBytes,
        minRelayFee,
      };
    }

    if (tx.fee < minRelayFee) {
      return {
        ok: false,
        reason: `underpriced fee=${tx.fee} minRelayFee=${minRelayFee} txBytes=${txBytes}`,
        txBytes,
        minRelayFee,
      };
    }

    return { ok: true, txBytes, minRelayFee };
  }

  private txEvictionCandidate(tx: Tx): MempoolEvictionCandidate | null {
    if (!tx.from) return null;

    const related = Array.from(this.mempool.values())
      .filter((x) => x.from === tx.from && x.nonce >= tx.nonce)
      .sort((a, b) => a.nonce - b.nonce);

    const packageTxIds = related.map((x) => x.id);
    const packageFees = related.reduce((sum, x) => sum + x.fee, 0);
    const packageBytes = related.reduce((sum, x) => sum + Math.max(1, txRelayBytes(x)), 0);

    return {
      txId: tx.id,
      from: tx.from,
      nonce: tx.nonce,
      fee: tx.fee,
      amount: tx.amount,
      txBytes: txRelayBytes(tx),
      feeRate: txFeeRate(tx),
      descendantCount: Math.max(0, related.length - 1),
      packageTxIds,
      packageFees,
      packageBytes,
      packageFeeRate: packageBytes > 0 ? packageFees / packageBytes : 0,
    };
  }

  private lowestEvictionCandidate(scopeFrom?: string): MempoolEvictionCandidate | null {
    const txs = Array.from(this.mempool.values())
      .filter((tx) => tx.from)
      .filter((tx) => !scopeFrom || tx.from === scopeFrom);

    if (!txs.length) return null;

    txs.sort((a, b) => {
      const weak = compareTxWeakness(a, b);
      if (weak !== 0) return weak;
      return a.nonce - b.nonce;
    });

    for (const tx of txs) {
      const candidate = this.txEvictionCandidate(tx);
      if (candidate) return candidate;
    }

    return null;
  }

  private evictMempoolCandidate(candidate: MempoolEvictionCandidate): MempoolEvictionCandidate {
    for (const txId of candidate.packageTxIds) {
      this.mempool.delete(txId);
    }

    this.rebuildMempoolReservations();

    console.log(
      `🧹 mempool evict package reason=low-priority root=${candidate.txId.slice(0, 12)}... txs=${candidate.packageTxIds.length} packageFeeRate=${candidate.packageFeeRate.toFixed(
        8
      )}`
    );

    return candidate;
  }

  private maybeEvictForAdmission(tx: Tx): MempoolEvictionCandidate[] | null {
    const out: MempoolEvictionCandidate[] = [];
    const incomingRate = txFeeRate(tx);

    if (tx.from && this.mempoolSenderCount(tx.from) >= MAX_MEMPOOL_TXS_PER_SENDER) {
      const senderWeakest = this.lowestEvictionCandidate(tx.from);
      if (!senderWeakest) return null;

      if (incomingRate <= senderWeakest.packageFeeRate) {
        console.log(
          `❌ mempool reject ${tx.id.slice(0, 12)} reason=sender-full-low-priority incomingRate=${incomingRate.toFixed(
            8
          )} weakestPackageRate=${senderWeakest.packageFeeRate.toFixed(8)}`
        );
        return null;
      }

      out.push(this.evictMempoolCandidate(senderWeakest));
    }

    while (this.mempool.size >= MAX_MEMPOOL_TXS) {
      const weakest = this.lowestEvictionCandidate();
      if (!weakest) return null;

      if (incomingRate <= weakest.packageFeeRate) {
        console.log(
          `❌ mempool reject ${tx.id.slice(0, 12)} reason=mempool-full-low-priority incomingRate=${incomingRate.toFixed(
            8
          )} weakestPackageRate=${weakest.packageFeeRate.toFixed(8)}`
        );
        return null;
      }

      out.push(this.evictMempoolCandidate(weakest));
    }

    return out;
  }

  getMempoolStats(): MempoolStats {
    const txs = Array.from(this.mempool.values());
    const totalBytes = txs.reduce((sum, tx) => sum + txRelayBytes(tx), 0);
    const rates = txs.map((tx) => txFeeRate(tx));
    const senders = new Set(txs.map((tx) => tx.from).filter(Boolean) as string[]);

    const lowest = this.lowestEvictionCandidate();

    return {
      size: this.mempool.size,
      maxSize: MAX_MEMPOOL_TXS,
      senderCount: senders.size,
      maxPerSender: MAX_MEMPOOL_TXS_PER_SENDER,
      totalBytes,
      minFeeRate: rates.length ? Math.min(...rates) : null,
      maxFeeRate: rates.length ? Math.max(...rates) : null,
      avgFeeRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      lowestTx: lowest,
    };
  }

  private blockIndexByHash(hash: string): number {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].hash === hash) return i;
    }
    return -1;
  }

  private chainHasHash(hash: string): boolean {
    if (this.checkpoint && this.checkpoint.tipHash === hash) return true;
    return this.blockIndexByHash(hash) !== -1;
  }

  private removeOrphan(hash: string) {
    const blk = this.orphanBlocks.get(hash);
    if (!blk) return;

    this.orphanBlocks.delete(hash);
    this.orphanReceivedAt.delete(hash);
    this.orphanOrder = this.orphanOrder.filter((h) => h !== hash);

    const s = this.orphansByPrev.get(blk.prevHash);
    if (s) {
      s.delete(hash);
      if (s.size === 0) this.orphansByPrev.delete(blk.prevHash);
    }
  }

  private removeOrphanSubtree(rootHash: string, budget = ORPHAN_PROCESS_BUDGET) {
    const queue: string[] = [rootHash];
    let steps = 0;

    while (queue.length > 0 && steps < budget) {
      const hash = queue.shift()!;
      steps++;

      const children = Array.from(this.orphansByPrev.get(hash) ?? []);
      for (const child of children) queue.push(child);

      this.removeOrphan(hash);
    }
  }

  private evictOldestOrphan() {
    const oldest = this.orphanOrder[0];
    if (!oldest) return;
    console.log(`🧹 evict orphan ${oldest.slice(0, 12)}...`);
    this.removeOrphanSubtree(oldest);
  }

  private storeOrphan(block: Block): boolean {
    if (!block?.hash) return false;
    this.pruneOrphans();

    if (this.chainHasHash(block.hash)) return false;
    if (this.orphanBlocks.has(block.hash)) return false;

    this.orphanBlocks.set(block.hash, block);
    this.orphanOrder.push(block.hash);
    this.orphanReceivedAt.set(block.hash, now());

    const s = this.orphansByPrev.get(block.prevHash) ?? new Set<string>();
    s.add(block.hash);
    this.orphansByPrev.set(block.prevHash, s);

    console.log(
      `🪶 stored orphan ${block.hash.slice(0, 12)}... prev=${block.prevHash.slice(0, 12)}... orphans=${this.orphanBlocks.size}`
    );

    while (this.orphanBlocks.size > MAX_ORPHAN_BLOCKS) {
      this.evictOldestOrphan();
    }

    return true;
  }

  private processOrphansFrom(parentHash: string, budget = ORPHAN_PROCESS_BUDGET) {
    this.pruneOrphans();

    const queue: string[] = [parentHash];
    let steps = 0;

    while (queue.length > 0 && steps < budget) {
      const curParent = queue.shift()!;
      const direct = Array.from(this.orphansByPrev.get(curParent) ?? []);
      if (direct.length > 0) {
        console.log(`🧷 orphan children for ${curParent.slice(0, 12)}... count=${direct.length}`);
      }

      for (const orphanHash of direct) {
        if (steps >= budget) break;
        steps++;

        const orphan = this.orphanBlocks.get(orphanHash);
        if (!orphan) continue;

        this.removeOrphan(orphanHash);
        console.log(`🔗 trying orphan attach ${orphan.hash.slice(0, 12)}...`);

        const added = this.tryAddBlock(orphan);
        if (added) {
          console.log(`✅ attached orphan ${orphan.hash.slice(0, 12)}... height=${this.height()}`);
          queue.push(orphan.hash);
        } else if (!this.chainHasHash(orphan.prevHash)) {
          console.log(`↩️ orphan still waiting ${orphan.hash.slice(0, 12)}...`);
          this.storeOrphan(orphan);
        } else {
          console.log(`❌ orphan attach failed ${orphan.hash.slice(0, 12)}...`);
          this.removeOrphanSubtree(orphan.hash);
        }
      }
    }

    this.pruneOrphans();
  }

  private loadSnapshotForBlocks(blocks: Block[]): { ok: boolean; loaded?: LoadedSnapshot; reason?: string } {
    const sf = snapshotFileFor(this.chainFile);
    const sbf = snapshotBackupFileFor(this.chainFile);

    const primaryRes = readJSONDetailed<Snapshot>(sf);
    let snap: Snapshot | null = null;
    let loadedFrom = sf;

    if (primaryRes.ok) {
      snap = primaryRes.data;
    } else {
      let primaryReason = primaryRes.reason;

      if (primaryRes.reason === "parse-error") {
        const moved = quarantineFile(sf, "badjson");
        if (moved) {
          console.log(`⚠️ snapshot quarantined ${sf} -> ${moved} | reason=bad-json`);
          primaryReason = "parse-error";
        }
      }

      const backupRes = readJSONDetailed<Snapshot>(sbf);
      if (backupRes.ok) {
        snap = backupRes.data;
        loadedFrom = sbf;
        console.log(`⚠️ snapshot primary unavailable, loaded backup ${sbf}`);
      } else {
        if (primaryRes.reason === "missing" && backupRes.reason === "missing") {
          return { ok: false, reason: "snapshot missing" };
        }

        if (primaryReason === "parse-error") {
          return { ok: false, reason: "snapshot quarantined bad-json" };
        }

        return {
          ok: false,
          reason: `snapshot unavailable primary=${primaryRes.reason} backup=${backupRes.reason}`,
        };
      }
    }

    const checked = validateLoadedSnapshot(blocks, snap, this.checkpoint?.height ?? 0);
    if (!checked.ok || !checked.loaded) return { ok: false, reason: checked.reason };

    if (loadedFrom !== sf) {
      try {
        writeJSON(sf, snap);
        try {
          copyFileAtomic(sf, sbf);
        } catch {}
        console.log(`🩹 restored primary snapshot from backup -> ${sf}`);
      } catch (e: any) {
        console.log(`⚠️ failed to restore primary snapshot from backup | reason=${e?.message ?? String(e)}`);
      }
    }

    return { ok: true, loaded: checked.loaded };
  }

  private saveSnapshot() {
    if (!this.stateCache) return;

    const sf = snapshotFileFor(this.chainFile);
    const sbf = snapshotBackupFileFor(this.chainFile);

    const snap: Snapshot = {
      height: this.height(),
      tipHash: this.tipHash(),
      minted: this.stateCache.minted,
      balances: mapToObjNum(this.stateCache.balances),
      nonces: mapToObjNum(this.stateCache.nonces),
      pending: pendingMapToObj(this.stateCache.pending),
    };

    asyncDiskQueue.writeJson(sf, snap, sbf);
    console.log(`💾 snapshot write queued | height=${snap.height} | file=${sf}`);
  }

  exportCheckpointSnapshot(): SnapshotImportJson | null {
    const st = this.getState();
    const tip = this.blocks[this.blocks.length - 1];
    return {
      height: this.height(),
      tipHash: tip.hash,
      stateRoot: tip.stateRoot,
      minted: st.minted,
      balances: mapToObjNum(st.balances),
      nonces: mapToObjNum(st.nonces),
      pending: pendingMapToObj(st.pending),
      createdAt: now(),
    };
  }

  importCheckpointSnapshot(snapshot: SnapshotImportJson): boolean {
    if (!snapshot || typeof snapshot !== "object") return false;
    if (!isSafeInt(snapshot.height) || snapshot.height < 0) return false;
    if (typeof snapshot.tipHash !== "string" || !snapshot.tipHash) return false;
    if (typeof snapshot.stateRoot !== "string" || !snapshot.stateRoot) return false;
    if (!snapshot.balances || typeof snapshot.balances !== "object") return false;
    if (!snapshot.nonces || typeof snapshot.nonces !== "object") return false;
    if (!snapshot.pending || typeof snapshot.pending !== "object") return false;

    const state: ReplayState = {
      balances: objToMapNum(snapshot.balances),
      nonces: objToMapNum(snapshot.nonces),
      pending: pendingObjToMap(snapshot.pending),
      minted: snapshot.minted ?? 0,
    };

    const computedRoot = computeStateRoot(state);
    if (computedRoot !== snapshot.stateRoot) {
      console.log(`❌ checkpoint import rejected reason=stateRoot-mismatch`);
      return false;
    }

    const anchor = new Block({
      prevHash: "",
      difficulty: GENESIS_DIFFICULTY,
      txs: [],
      stateRoot: snapshot.stateRoot,
      ts: GENESIS_TS,
      nonce: GENESIS_NONCE,
      hash: snapshot.tipHash,
    });

    this.clearCheckpoint();
    this.blocks = [anchor];
    this.mempool.clear();
    this.mempoolReserved.clear();
    this.mempoolNextNonce.clear();
    this.orphanBlocks.clear();
    this.orphanOrder = [];
    this.orphanReceivedAt.clear();
    this.orphansByPrev.clear();

    this.checkpoint = {
      height: snapshot.height,
      tipHash: snapshot.tipHash,
      stateRoot: snapshot.stateRoot,
      state,
    };
    this.stateCache = cloneState(state);

    console.log(
      `⚡ imported checkpoint | height=${snapshot.height} | tip=${snapshot.tipHash.slice(0, 12)}... | stateRoot=${snapshot.stateRoot.slice(0, 12)}...`
    );
    this.logStorageStats("🧹 storage stats after checkpoint import");

    this.save();
    this.saveSnapshot();
    this.saveChainstateNow("checkpoint-import");

    return true;
  }

  load(file: string) {
    this.chainFile = file;

    const recoveredJournal = recoverCrashJournal(file);
    if (recoveredJournal.recovered) {
      console.log(`🧯 crash journal recovery noted | file=${recoveredJournal.journalFile} | reason=${recoveredJournal.reason}`);
    } else if (!recoveredJournal.ok) {
      console.log(`⚠️ crash journal recovery check failed | file=${recoveredJournal.journalFile} | reason=${recoveredJournal.reason}`);
    }

    const autoRepair = recoverChainFiles(file);
    if (autoRepair.repaired) {
      console.log(`🩹 chain auto-repair complete | file=${file} | ok=${autoRepair.ok} | errors=${autoRepair.errors.length}`);
    }
    if (!autoRepair.ok) {
      console.log(`⚠️ chain auto-repair could not validate primary chain | file=${file} | errors=${autoRepair.errors.join(",")}`);
    }

    const backupFile = backupFileFor(file);

    const primaryRes = readJSONDetailed(file);
    let j: any | null = null;
    let loadedFrom = file;

    if (primaryRes.ok) {
      j = primaryRes.data;
    } else {
      const backupRes = readJSONDetailed(backupFile);
      if (!backupRes.ok) return false;
      j = backupRes.data;
      loadedFrom = backupFile;
      console.log(`⚠️ primary chain file unreadable, loaded backup ${backupFile}`);
    }

    this.pruneConfig = normalizePruneConfig(j?.pruneConfig);

    const blocks = (j?.blocks ?? []).map((x: any) => Block.fromJSON(x));
    if (!blocks.length) return false;

    this.clearCheckpoint();
    this.loadCheckpointFromChainFile(j, blocks);

    let finalState: ReplayState | null = null;

    const separatedChainstate = this.loadSeparatedChainstateForBlocks(blocks);

    if (separatedChainstate) {
      finalState = separatedChainstate;
    } else {
      const snap = this.loadSnapshotForBlocks(blocks);

      if (snap.ok && snap.loaded) {
      const startHeight = this.checkpoint ? 1 : snap.loaded.height + 1;
      const replayed = Math.max(0, blocks.length - startHeight);
      console.log(
        `⚡ snapshot restore ${snapshotFileFor(this.chainFile)} | height=${snap.loaded.height} | replayTail=${replayed}`
      );

      if (this.checkpoint) {
        console.log(
          `⚓ checkpoint restore ${loadedFrom} | height=${this.checkpoint.height} | localBlocks=${blocks.length} | replayTail=${Math.max(
            0,
            blocks.length - 1
          )}`
        );
      }

      if (this.checkpoint && blocks.length === 1) {
        finalState = cloneState(this.checkpoint.state);
      } else if (this.checkpoint) {
        const resumed = replayValidateChainFromState(
          blocks,
          1,
          this.checkpoint.state,
          this.checkpoint.height
        );
        if (!resumed.ok || !resumed.state) {
          console.log(`⚠️ checkpoint restore failed, falling back to full replay | reason=${resumed.reason}`);
          return false;
        }
        finalState = resumed.state;
      } else {
        const resumed = replayValidateChainFromState(blocks, startHeight, snap.loaded.state);
        if (!resumed.ok || !resumed.state) {
          console.log(`⚠️ snapshot restore failed, falling back to full replay | reason=${resumed.reason}`);
          const full = replayValidateChain(blocks);
          if (!full.ok || !full.state) return false;
          finalState = full.state;
        } else {
          finalState = resumed.state;
        }
      }
    } else {
      if (snap.reason && snap.reason !== "snapshot missing") {
        console.log(`⚠️ snapshot ignored ${snapshotFileFor(this.chainFile)} | reason=${snap.reason}`);
      }

      if (this.checkpoint) {
        console.log(
          `⚓ checkpoint restore ${loadedFrom} | height=${this.checkpoint.height} | localBlocks=${blocks.length} | replayTail=${Math.max(
            0,
            blocks.length - 1
          )}`
        );

        const resumed = replayValidateChainFromState(
          blocks,
          1,
          this.checkpoint.state,
          this.checkpoint.height
        );
        if (!resumed.ok || !resumed.state) return false;
        finalState = resumed.state;
      } else {
        const full = replayValidateChain(blocks);
        if (!full.ok || !full.state) return false;
        finalState = full.state;
      }
    }

    }

    this.blocks = blocks;
    this.stateCache = finalState;
    this.orphanBlocks.clear();
    this.orphanOrder = [];
    this.orphanReceivedAt.clear();
    this.orphansByPrev.clear();

    this.mempool.clear();
    for (const x of j?.mempool ?? []) {
      const t = Tx.fromJSON(x);
      if (t.type !== "TRANSFER" || !t.verify() || !t.from) continue;
      const policy = this.assessMempoolPolicy(t);
      if (policy.ok) {
        this.mempool.set(t.id, t);
      }
    }

    this.rebuildMempoolReservations();

    this.logStorageStats("🧹 prune config loaded");

    if (loadedFrom !== file) {
      try {
        this.save();
        console.log(`🩹 restored primary chain file from backup -> ${file}`);
      } catch (e: any) {
        console.log(`⚠️ failed to rewrite primary from backup | reason=${e?.message ?? String(e)}`);
      }
    }

    return true;
  }

  save() {
    const journal = beginCrashJournal({
      chainFile: this.chainFile,
      operation: "save",
      height: this.height(),
      tipHash: this.tipHash(),
      stateRoot: this.blocks[this.blocks.length - 1]?.stateRoot ?? null,
      note: "queue chain save",
      files: {
        chainFile: this.chainFile,
        chainBackupFile: backupFileFor(this.chainFile),
        chainstateFile: chainstateFileFor(this.chainFile),
        chainstateBackupFile: chainstateBackupFileFor(this.chainFile),
        snapshotFile: snapshotFileFor(this.chainFile),
        snapshotBackupFile: snapshotBackupFileFor(this.chainFile),
      },
    });

    try {
      updateCrashJournal(this.chainFile, { stage: "prune", note: "maybe prune old blocks" });
      this.maybePruneOldBlocks();
      this.pruneOrphans();

      const chainJson = {
        pruneConfig: this.pruneConfig,
        checkpoint: this.checkpoint
          ? {
              height: this.checkpoint.height,
              tipHash: this.checkpoint.tipHash,
              stateRoot: this.checkpoint.stateRoot,
              state: serializeReplayState(this.checkpoint.state),
            }
          : null,
        blocks: this.blocks.map((b) => b.toJSON()),
        mempool: Array.from(this.mempool.values()).map((t) => t.toJSON()),
      };

      updateCrashJournal(this.chainFile, {
        stage: "chain-save",
        height: this.height(),
        tipHash: this.tipHash(),
        stateRoot: this.blocks[this.blocks.length - 1]?.stateRoot ?? null,
        note: "queue chain json write",
      });

      asyncDiskQueue.writeJson(this.chainFile, chainJson, backupFileFor(this.chainFile));
      console.log(
        `💾 chain write queued | file=${this.chainFile} | height=${this.height()} | blocks=${this.blocks.length} | mempool=${this.mempool.size} | journal=${journal.id}`
      );

      if (this.stateCache) {
        updateCrashJournal(this.chainFile, { stage: "chainstate-save", note: "queue separated chainstate write" });
        this.saveChainstateNow("chain-save");
      }

      if (this.stateCache && this.height() > 0 && this.height() % SNAPSHOT_EVERY === 0) {
        updateCrashJournal(this.chainFile, { stage: "snapshot-save", note: "queue snapshot write" });
        this.saveSnapshot();
      }

      completeCrashJournal(this.chainFile, "save queued successfully");
    } catch (e: any) {
      abortCrashJournal(this.chainFile, e?.message ?? String(e));
      throw e;
    }
  }

  getBalance(pubKey: string) {
    return getMapNum(this.getState().balances, pubKey);
  }
  getImmature(pubKey: string) {
    const st = this.getState();
    let total = 0;
    for (const pr of st.pending.get(pubKey) ?? []) total += pr.amount;
    return total;
  }
  getSpendable(pubKey: string) {
    return this.getBalance(pubKey);
  }
  getTotal(pubKey: string) {
    return this.getSpendable(pubKey) + this.getImmature(pubKey);
  }
  confirmedNonce(pubKey: string) {
    return getMapNum(this.getState().nonces, pubKey);
  }
  nextNonce(pubKey: string) {
    const confirmed = this.confirmedNonce(pubKey);
    const memNext = this.mempoolNextNonce.get(pubKey);
    return memNext ?? confirmed + 1;
  }

  private rebuildMempoolReservations() {
    this.mempoolReserved.clear();
    this.mempoolNextNonce.clear();

    const byFrom = new Map<string, Tx[]>();
    for (const t of this.mempool.values()) {
      if (!t.from) continue;
      const arr = byFrom.get(t.from) ?? [];
      arr.push(t);
      byFrom.set(t.from, arr);
    }

    for (const [from, arr] of byFrom.entries()) {
      arr.sort((a, b) => a.nonce - b.nonce);

      let reserved = 0;
      let n = this.confirmedNonce(from) + 1;

      for (const t of arr) {
        if (t.nonce !== n) continue;
        reserved += t.amount + t.fee;
        n++;
      }

      if (reserved > 0) this.mempoolReserved.set(from, reserved);
      this.mempoolNextNonce.set(from, n);
    }
  }

  addToMempool(tx: Tx): boolean {
    const fromShort = tx.from ? sha256(tx.from).slice(0, 12) : "null";
    const txShort = tx.id ? tx.id.slice(0, 12) : "unknown";
    const mempoolSizeBefore = this.mempool.size;

    if (this.mempool.has(tx.id)) {
      console.log(`❌ mempool reject ${txShort} reason=duplicate`);
      return false;
    }
    if (tx.type !== "TRANSFER") {
      console.log(`❌ mempool reject ${txShort} reason=type type=${tx.type}`);
      return false;
    }
    if (!tx.verify()) {
      console.log(`❌ mempool reject ${txShort} reason=bad-sig from=${fromShort}`);
      return false;
    }

    if (!tx.from) {
      console.log(`❌ mempool reject ${txShort} reason=missing-from`);
      return false;
    }
    if (!isSafeInt(tx.amount) || tx.amount <= 0) {
      console.log(`❌ mempool reject ${txShort} reason=bad-amount amount=${tx.amount}`);
      return false;
    }
    if (!isSafeInt(tx.fee) || tx.fee < MIN_FEE) {
      console.log(`❌ mempool reject ${txShort} reason=bad-fee fee=${tx.fee} minFee=${MIN_FEE}`);
      return false;
    }
    if (!isSafeInt(tx.nonce) || tx.nonce <= 0) {
      console.log(`❌ mempool reject ${txShort} reason=bad-nonce nonce=${tx.nonce}`);
      return false;
    }

    const policy = this.assessMempoolPolicy(tx);
    if (!policy.ok) {
      console.log(`❌ mempool reject ${txShort} reason=${policy.reason}`);
      return false;
    }

    const confirmedNonce = this.confirmedNonce(tx.from);
    const wantNonce = this.nextNonce(tx.from);
    if (tx.nonce !== wantNonce) {
      console.log(
        `❌ mempool reject ${txShort} reason=nonce-mismatch from=${fromShort} got=${tx.nonce} want=${wantNonce} confirmed=${confirmedNonce}`
      );
      return false;
    }

    const evicted = this.maybeEvictForAdmission(tx);
    if (evicted === null) {
      console.log(
        `❌ mempool reject ${txShort} reason=eviction-policy from=${fromShort} mempoolSize=${this.mempool.size}/${MAX_MEMPOOL_TXS}`
      );
      return false;
    }

    const spendable = this.getSpendable(tx.from);
    const reserved = this.mempoolReserved.get(tx.from) ?? 0;
    const need = tx.amount + tx.fee;

    if (spendable - reserved < need) {
      console.log(
        `❌ mempool reject ${txShort} reason=insufficient from=${fromShort} spendable=${spendable} reserved=${reserved} need=${need}`
      );

      if (evicted.length > 0) {
        console.log(
          `⚠️ mempool note ${txShort} rejected after eviction; reservations rebuilt. evictedTxs=${evicted
            .flatMap((x) => x.packageTxIds)
            .length}`
        );
      }

      this.rebuildMempoolReservations();
      return false;
    }

    this.mempool.set(tx.id, tx);
    this.rebuildMempoolReservations();

    console.log(
      `✅ mempool accept ${txShort} from=${fromShort} nonce=${tx.nonce} amount=${tx.amount} fee=${tx.fee} feeRate=${txFeeRate(
        tx
      ).toFixed(8)} bytes=${policy.txBytes} evicted=${evicted.flatMap((x) => x.packageTxIds).length} size=${mempoolSizeBefore}->${this.mempool.size}`
    );

    this.save();
    return true;
  }

  nextDifficulty(): number {
    const localTipIdx = this.blocks.length - 1;
    let d = this.blocks[localTipIdx].difficulty;

    if (localTipIdx >= 1) {
      const blockTime = this.blocks[localTipIdx].ts - this.blocks[localTipIdx - 1].ts;
      if (blockTime > TARGET_BLOCK_MS * 4) d = Math.max(MIN_DIFFICULTY, d - 1);
    }

    if (localTipIdx < DIFF_WINDOW + 1) return clamp(d, MIN_DIFFICULTY, MAX_DIFFICULTY);

    const tip = this.blocks[localTipIdx];
    const prev = this.blocks[localTipIdx - DIFF_WINDOW];

    const actual = tip.ts - prev.ts;
    const expected = TARGET_BLOCK_MS * DIFF_WINDOW;

    if (actual < expected * 0.75) d += 1;
    else if (actual > expected * 1.25) d -= 1;

    return clamp(d, MIN_DIFFICULTY, MAX_DIFFICULTY);
  }

  buildBlock(minerPubKey: string): Block {
    const diff = this.nextDifficulty();
    const nextH = this.height() + 1;

    const sorted = Array.from(this.mempool.values()).sort(compareTxPriority);

    const selected: Tx[] = [];
    let bytes = 0;
    const nextNonceNeeded = new Map<string, number>();

    for (const t of sorted) {
      if (!t.from) continue;
      if (selected.length >= MAX_TX_PER_BLOCK) break;

      const nNeed = nextNonceNeeded.get(t.from) ?? (this.confirmedNonce(t.from) + 1);
      if (t.nonce !== nNeed) continue;

      const tb = approxBytes(t.toJSON());
      if (bytes + tb > MAX_BLOCK_BYTES) continue;

      selected.push(t);
      bytes += tb;
      nextNonceNeeded.set(t.from, nNeed + 1);
    }

    const fees = selected.reduce((s, t) => s + t.fee, 0);
    const subsidy = blockRewardAtHeight(nextH);

    const coinbase = new Tx({
      type: "COINBASE",
      from: null,
      to: minerPubKey,
      amount: subsidy + fees,
      fee: 0,
      nonce: 0,
    });

    const prevTs = this.blocks[this.blocks.length - 1].ts;
    const mtp = medianTimePast(this.blocks, this.blocks.length - 1);
    const ts = Math.max(now(), prevTs, mtp + 1);

    const block = new Block({
      prevHash: this.tipHash(),
      difficulty: diff,
      txs: [coinbase, ...selected],
      ts,
    });

    const post = computePostStateForBlock(this.getState(), block, nextH, this.tipHash(), prevTs, mtp, false);
    if (!post.ok || !post.stateRoot) throw new Error(`Failed to compute stateRoot for block: ${post.reason}`);

    block.stateRoot = post.stateRoot;
    block.hash = block.computeHash();
    return block;
  }

  validateBlock(block: Block): boolean {
    if (block.prevHash !== this.tipHash()) return false;

    const height = this.height() + 1;
    const prevTs = this.blocks[this.blocks.length - 1].ts;
    const mtp = medianTimePast(this.blocks, this.blocks.length - 1);

    const post = computePostStateForBlock(this.getState(), block, height, this.tipHash(), prevTs, mtp, true);
    if (!post.ok || !post.stateRoot) return false;
    return block.stateRoot === post.stateRoot;
  }

  tryAddBlock(block: Block): boolean {
    if (!block?.hash) return false;
    this.pruneOrphans();

    if (this.chainHasHash(block.hash)) {
      this.removeOrphanSubtree(block.hash);
      return false;
    }

    if (block.prevHash !== this.tipHash()) {
      if (!this.chainHasHash(block.prevHash)) {
        this.storeOrphan(block);
      } else {
        this.removeOrphanSubtree(block.hash);
      }
      return false;
    }

    if (!this.validateBlock(block)) {
      this.removeOrphanSubtree(block.hash);
      return false;
    }

    const height = this.height() + 1;
    const prevTs = this.blocks[this.blocks.length - 1].ts;
    const mtp = medianTimePast(this.blocks, this.blocks.length - 1);

    const post = computePostStateForBlock(this.getState(), block, height, this.tipHash(), prevTs, mtp, true);
    if (!post.ok || !post.state || !post.stateRoot) {
      this.removeOrphanSubtree(block.hash);
      return false;
    }
    if (block.stateRoot !== post.stateRoot) {
      this.removeOrphanSubtree(block.hash);
      return false;
    }

    this.blocks.push(block);
    this.stateCache = post.state;

    for (const t of block.txs.slice(1)) this.mempool.delete(t.id);

    this.rebuildMempoolReservations();
    this.removeOrphanSubtree(block.hash);
    this.save();
    this.processOrphansFrom(block.hash);
    return true;
  }

  validateChain(blocks: Block[]): boolean {
    return replayValidateChain(blocks).ok === true;
  }

  private findForkIndex(incoming: Block[]): number {
    const localIndexByHash = new Map<string, number>();
    for (let i = 0; i < this.blocks.length; i++) localIndexByHash.set(this.blocks[i].hash, i);

    for (let i = incoming.length - 1; i >= 0; i--) {
      const idx = localIndexByHash.get(incoming[i].hash);
      if (idx !== undefined) return idx;
    }
    return 0;
  }

  private reorgToIncoming(incoming: Block[]) {
    const forkIdx = this.findForkIndex(incoming);
    const st = cloneState(this.getState());

    const orphanedBlocks = this.blocks.slice(forkIdx + 1);
    for (let i = this.blocks.length - 1; i > forkIdx; i--) {
      undoBlockFromState(st, this.blocks[i], this.checkpoint ? this.checkpoint.height + i : i);
    }

    let prevHash = incoming[forkIdx].hash;
    for (let i = forkIdx + 1; i < incoming.length; i++) {
      const prevTs = incoming[i - 1].ts;
      const mtp = medianTimePast(incoming, i - 1);
      const absHeight = this.checkpoint ? this.checkpoint.height + i : i;
      const post = computePostStateForBlock(st, incoming[i], absHeight, prevHash, prevTs, mtp, true);
      if (!post.ok || !post.state || !post.stateRoot) {
        this.blocks = incoming;
        this.stateCache = null;
        this.rebuildState();
        this.rebuildMempoolReservations();
        this.pruneOrphans();
        this.save();
        this.processOrphansFrom(this.tipHash());
        return;
      }
      if (incoming[i].stateRoot !== post.stateRoot) {
        this.blocks = incoming;
        this.stateCache = null;
        this.rebuildState();
        this.rebuildMempoolReservations();
        this.pruneOrphans();
        this.save();
        this.processOrphansFrom(this.tipHash());
        return;
      }

      st.balances = post.state.balances;
      st.nonces = post.state.nonces;
      st.pending = post.state.pending;
      st.minted = post.state.minted;
      prevHash = incoming[i].hash;
    }

    this.blocks = incoming;
    this.stateCache = cloneState(st);

    const candidate: Tx[] = [];
    for (const b of orphanedBlocks) for (const t of b.txs.slice(1)) if (t.type === "TRANSFER") candidate.push(t);
    for (const t of this.mempool.values()) candidate.push(t);

    this.mempool.clear();
    this.rebuildMempoolReservations();

    for (const t of candidate) if (t.type === "TRANSFER" && t.verify()) this.addToMempool(t);

    this.pruneOrphans();
    this.save();
    this.processOrphansFrom(this.tipHash());
  }

  tryAdoptChain(rawBlocks: any[]): boolean {
    const incoming = rawBlocks.map((b) => Block.fromJSON(b));
    if (incoming.length < 1) return false;
    if (!this.validateChain(incoming)) return false;

    const myWork = chainWork(this.blocks);
    const inWork = chainWork(incoming);
    if (inWork <= myWork) return false;

    this.reorgToIncoming(incoming);
    return true;
  }

  tryAdoptForkFromHeight(commonHeight: number, rawTailBlocks: any[]): boolean {
    if (this.checkpoint && commonHeight < this.checkpoint.height) return false;

    const localStart = this.checkpoint ? this.checkpoint.height : 0;
    const h = Math.max(localStart, Math.min(commonHeight, this.height()));
    const localIdx = h - localStart;

    const prefix = this.blocks.slice(0, localIdx + 1);
    const tail = rawTailBlocks.map((b) => Block.fromJSON(b));
    if (tail.length === 0) return false;

    if (tail[0].prevHash !== prefix[prefix.length - 1].hash) return false;

    const incoming = prefix.concat(tail);

    if (!this.checkpoint) {
      if (!this.validateChain(incoming)) return false;
    } else {
      const res = replayValidateChainFromState(incoming, 1, this.checkpoint.state, this.checkpoint.height);
      if (!res.ok) return false;
    }

    const myWork = chainWork(this.blocks);
    const inWork = chainWork(incoming);
    if (inWork <= myWork) return false;

    this.reorgToIncoming(incoming);
    return true;
  }

  applyBlockRange(fromHeight: number, rawBlocks: any[]): boolean {
    this.pruneOrphans();

    const from = Math.max(0, fromHeight | 0);
    if (!rawBlocks.length) return false;

    if (from === this.height() + 1) {
      const first = Block.fromJSON(rawBlocks[0]);
      if (first.prevHash === this.tipHash()) {
        let ok = true;
        for (const rb of rawBlocks) {
          const b = Block.fromJSON(rb);
          if (!this.tryAddBlock(b)) {
            ok = false;
            break;
          }
        }
        this.pruneOrphans();
        return ok;
      }
    }

    const commonHeight = Math.max(this.checkpoint ? this.checkpoint.height : 0, from - 1);
    const adopted = this.tryAdoptForkFromHeight(commonHeight, rawBlocks);
    this.pruneOrphans();
    return adopted;
  }
}