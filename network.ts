// network.ts
import WebSocket, { WebSocketServer } from "ws";
import { URL } from "url";
import * as fs from "fs";
import * as zlib from "zlib";
import * as https from "https";
import {
  peerReputation,
  type PeerReputationEvent,
  type PeerReputationSnapshot,
} from "./peer-reputation";
import {
  bandwidthThrottle,
  type BandwidthPeerSnapshot,
  type BandwidthThrottleSummary,
} from "./bandwidth-throttle";
import {
  loadP2PTlsConfig,
  buildP2PTlsServerOptions,
  buildP2PTlsClientOptions,
  getP2PTlsStats,
  type P2PTlsConfig,
  type P2PTlsStats,
} from "./tls-config";
import { getPublicSeedStats, type PublicSeedStats } from "./public-seeds";
import {
  getBootstrapCheckpointSigningStats,
  signBootstrapCheckpoint,
  verifyBootstrapCheckpointSignature,
  type BootstrapCheckpointSignature,
  type BootstrapCheckpointSigningStats,
} from "./bootstrap-checkpoint";
import {
  Chain,
  Tx,
  Block,
  CHAIN_ID,
  PROTOCOL_VERSION,
  NETWORK_MAGIC,
  BlockHeader,
  SnapshotImportJson,
  computeHeaderHash,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  GENESIS_HASH,
  verifyStateProof,
} from "./chain";

type CompactBlockJson = {
  hash: string;
  prevHash: string;
  ts: number;
  nonce: number;
  difficulty: number;
  stateRoot: string;
  height: number;
  coinbase: any;
  txIds: string[];
};

type SnapshotJson = SnapshotImportJson & { checkpointSignature?: BootstrapCheckpointSignature | null };

type SnapshotMetaJson = {
  height: number;
  tipHash: string;
  stateRoot: string;
  minted: number;
  balancesCount: number;
  noncesCount: number;
  pendingAccounts: number;
  pendingRewards: number;
  createdAt: number;
  checkpointSignature?: BootstrapCheckpointSignature | null;
};

type ProofKind = "balance" | "nonce" | "pending" | "minted";

type MsgCore =
  | { type: "PING" }
  | { type: "PONG" }
  | { type: "HEADERS_REQUEST" }
  | { type: "HEADERS_RESPONSE"; headers: BlockHeader[] }
  | { type: "BLOCK_RANGE_REQUEST"; fromHeight: number; maxCount: number }
  | { type: "BLOCK_RANGE_RESPONSE"; fromHeight: number; blocks: any[] }
  | { type: "BLOCK"; block: any }
  | { type: "BLOCK_INV"; hash: string; height: number }
  | { type: "BLOCK_GET"; hash: string }
  | { type: "BLOCK_FULL_GET"; hash: string }
  | { type: "COMPACT_BLOCK"; block: CompactBlockJson }
  | { type: "BLOCK_TX_GET"; hash: string; txIds: string[] }
  | { type: "BLOCK_TX_BATCH"; hash: string; txs: any[] }
  | { type: "TX"; tx: any }
  | { type: "TX_INV"; txIds: string[] }
  | { type: "TX_GET"; txIds: string[] }
  | { type: "TX_BATCH"; txs: any[] }
  | { type: "PEERS_REQUEST" }
  | { type: "PEERS_RESPONSE"; peers: string[] }
  | { type: "MEMPOOL_REQUEST"; reason?: string }
  | { type: "MEMPOOL_RESPONSE"; txs: any[] }
  | { type: "SNAPSHOT_META_REQUEST"; reqId: string }
  | { type: "SNAPSHOT_META_RESPONSE"; reqId: string; ok: boolean; snapshot?: SnapshotMetaJson; error?: string }
  | { type: "SNAPSHOT_REQUEST"; reqId: string }
  | { type: "SNAPSHOT_RESPONSE"; reqId: string; ok: boolean; snapshot?: SnapshotJson; error?: string }
  | { type: "PROOF_REQUEST"; kind: ProofKind; address?: string; pendingIndex?: number; reqId: string }
  | {
      type: "PROOF_RESPONSE";
      kind: ProofKind;
      address?: string | null;
      pendingIndex?: number | null;
      reqId: string;
      ok: boolean;
      verified: boolean;
      proof?: any;
      error?: string;
    };

type Envelope = { magic: number; chainId: string; version: number } & MsgCore;

type CompressedEnvelope = {
  magic: number;
  chainId: string;
  version: number;
  type: "COMPRESSED";
  codec: "gzip";
  innerType: MsgCore["type"];
  payloadBase64: string;
};

type PendingCompactBlock = {
  peer: string;
  compact: CompactBlockJson;
  fetchedTxs: Map<string, Tx>;
  requestedTxIds: Set<string>;
  requestRounds: number;
  createdAt: number;
  lastRequestAt: number;
  lastProgressAt: number;
  mempoolHits: number;
  recoveredTxs: number;
  missingLast: string[];
};

type SnapshotBootstrapState = {
  status: "idle" | "waiting-meta" | "waiting-snapshot" | "ready";
  peer: string | null;
  metaReqId: string | null;
  snapReqId: string | null;
  meta: SnapshotMetaJson | null;
  importedHeight: number | null;
  importedTipHash: string | null;
  remoteHeight: number;
  startedAt: number;
  finishedAt: number;
  reason: string | null;
};

export type NetworkPeerStats = {
  peer: string;
  url: string | null;
  ip: string;
  direction: "inbound" | "outbound" | "unknown";
  readyState: number;
  readyStateLabel: string;
  connectedAt: number | null;
  connectedForMs: number | null;
  lastSeenAt: number | null;
  idleMs: number | null;
  lastPingSentAt: number | null;
  latencyMs: number | null;
  remoteHeight: number | null;
  remoteTipHash: string | null;
  reputation: PeerReputationSnapshot;
  bandwidth: BandwidthPeerSnapshot;
};

export type NetworkStats = {
  startedAt: number;
  localPort: number;
  localHost: string;
  advertisedPeerUrl: string | null;
  p2pListening: boolean;
  tls: P2PTlsStats;
  publicSeeds: PublicSeedStats;
  checkpointSigning: BootstrapCheckpointSigningStats;
  socketsOpen: number;
  inboundOpen: number;
  outboundOpen: number;
  knownPeers: number;
  peerTableSize: number;
  reconnectScheduled: number;
  bannedIps: number;
  snapshotBootstrap: SnapshotBootstrapState & {
    lastCompletedAt: number;
  };
  sync: {
    localHeight: number;
    bestRemoteHeight: number;
    syncTargetHeight: number;
    syncProgressPct: number;
    lagBlocks: number;
    lastHeadersCommonHeight: number;
    lastHeadersRemoteHeight: number;
    lastChunkFromHeight: number;
    lastChunkSize: number;
    lastChunkAppliedHeight: number;
    lastChunkAt: number;
    activeSyncPeer: string | null;
  };
  traffic: {
    messagesReceived: number;
    messagesSent: number;
    bytesReceivedApprox: number;
    bytesSentApprox: number;
    compressedMessagesReceived: number;
    compressedMessagesSent: number;
  };
  counters: {
    discoveryDials: number;
    heartbeatPingsSent: number;
    staleSocketsClosed: number;
    reconnectAttempts: number;
    reconnectScheduled: number;
    rateLimitRejects: number;
    bansIssued: number;
    badMessages: number;
    bandwidthInboundAllowed: number;
    bandwidthInboundRejected: number;
    bandwidthOutboundAllowed: number;
    bandwidthOutboundRejected: number;
    bandwidthBytesDroppedApprox: number;
    tlsServerEnabled: number;
    tlsClientDials: number;
    tlsClientErrors: number;
    publicSeedDials: number;
    publicSeedDialErrors: number;
    checkpointSignaturesCreated: number;
    checkpointSignaturesVerified: number;
    checkpointSignatureRejects: number;
    checkpointUnsignedAccepted: number;
    headersResponsesSeen: number;
    blockRangeResponsesSeen: number;
    initialBlockDownloadRequests: number;
    initialBlockDownloadBlocks: number;
    initialBlockDownloadAdaptiveUpshifts: number;
    initialBlockDownloadAdaptiveDownshifts: number;
    initialBlockDownloadFastChunks: number;
    initialBlockDownloadRetryHeaders: number;
    initialBlockDownloadLastChunkMs: number;
    txAccepted: number;
    txRejected: number;
    txInvReceived: number;
    txBatchReceived: number;
    mempoolRequestsSent: number;
    mempoolResponsesReceived: number;
    snapshotMetaRequestsSent: number;
    snapshotMetaResponsesReceived: number;
    snapshotRequestsSent: number;
    snapshotResponsesReceived: number;
    snapshotImportsSucceeded: number;
    snapshotImportsFailed: number;
    snapshotResponsePlainSent: number;
    snapshotResponseCompressedSent: number;
    snapshotResponseRawBytes: number;
    snapshotResponsePackedBytes: number;
    snapshotResponseSavedBytes: number;
    snapshotResponseCompressionMs: number;
    snapshotMetaRawBytes: number;
    snapshotMetaPackedBytes: number;
    compactReceived: number;
    compactAccepted: number;
    compactRejected: number;
    compactStalled: number;
    compactRecoveredFromMempool: number;
    compactTxRequestsSent: number;
    compactTxsRequested: number;
    compactTxBatchesReceived: number;
    compactTxsRecovered: number;
    compactFullFallbacks: number;
    fullBlockReceived: number;
    fullBlockAccepted: number;
    fullBlockRejected: number;
    orphanStored: number;
    orphanResolvedApprox: number;
  };
  reputation: {
    totalTracked: number;
    trusted: number;
    good: number;
    neutral: number;
    warn: number;
    bad: number;
    banned: number;
    peers: PeerReputationSnapshot[];
  };
  bandwidth: BandwidthThrottleSummary;
  peers: NetworkPeerStats[];
};

const MAX_MSG_BYTES = 2_000_000;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT_COUNT = 250;
const MAX_INBOUND_PER_IP = 20;
const PEER_TABLE_MAX = 64;
const RECONNECT_MAX_DELAY_MS = 15_000;
const REQUEST_CHUNK_SIZE = 32;
const IBD_MIN_CHUNK_SIZE = 16;
const IBD_MAX_CHUNK_SIZE = 128;
const IBD_FAST_LAG_BLOCKS = 256;
const IBD_MEDIUM_LAG_BLOCKS = 96;
const IBD_FAST_RESPONSE_MS = 3_000;
const IBD_SLOW_RESPONSE_MS = 10_000;
const DISCOVERY_MS = 20_000;
const HEARTBEAT_MS = 15_000;
const STALE_SOCKET_MS = 60_000;

const MAX_TX_INV_IDS = 512;
const MAX_TX_GET_IDS = 512;
const MAX_TX_BATCH_TXS = 256;
const RECENT_TX_TTL_MS = 120_000;
const RECENT_TX_CACHE_MAX = 20_000;
const PEER_KNOWN_TX_MAX = 10_000;

const RECENT_BLOCK_TTL_MS = 120_000;
const RECENT_BLOCK_CACHE_MAX = 2_000;
const PEER_KNOWN_BLOCK_MAX = 2_000;
const MAX_BLOCK_TX_FETCH = 512;
const PENDING_COMPACT_MAX = 128;
const COMPACT_RECOVERY_MAX_ROUNDS = 3;
const COMPACT_RECOVERY_MIN_RETRY_MS = 250;

const MAX_REQ_ID_LEN = 128;

const SNAPSHOT_MIN_REMOTE_AHEAD = REQUEST_CHUNK_SIZE * 2;
const SNAPSHOT_MIN_GAIN_OVER_LOCAL = REQUEST_CHUNK_SIZE;
const SNAPSHOT_META_MAX_AGE_MS = 10 * 60_000;

const SNAPSHOT_COMPRESS_MIN_BYTES = 512;
const SNAPSHOT_COMPRESS_LEVEL = 9;
const SNAPSHOT_COMPRESS_WARN_RAW_BYTES = 1_000_000;

const COMPRESSIBLE_TYPES = new Set<MsgCore["type"]>([
  "BLOCK_RANGE_RESPONSE",
  "BLOCK",
  "COMPACT_BLOCK",
  "BLOCK_TX_BATCH",
  "TX_BATCH",
  "MEMPOOL_RESPONSE",
  "HEADERS_RESPONSE",
  "PROOF_RESPONSE",
  "SNAPSHOT_META_RESPONSE",
  "SNAPSHOT_RESPONSE",
]);

const COMPRESS_MIN_BYTES_BY_TYPE: Partial<Record<MsgCore["type"], number>> = {
  HEADERS_RESPONSE: 256,
  MEMPOOL_RESPONSE: 384,
  TX_BATCH: 384,
  BLOCK_TX_BATCH: 384,
  COMPACT_BLOCK: 256,
  BLOCK_RANGE_RESPONSE: 768,
  BLOCK: 1024,
  PROOF_RESPONSE: 256,
  SNAPSHOT_META_RESPONSE: 256,
  SNAPSHOT_RESPONSE: SNAPSHOT_COMPRESS_MIN_BYTES,
};

const COMPRESS_LEVEL_BY_TYPE: Partial<Record<MsgCore["type"], number>> = {
  HEADERS_RESPONSE: 4,
  MEMPOOL_RESPONSE: 5,
  TX_BATCH: 5,
  BLOCK_TX_BATCH: 5,
  COMPACT_BLOCK: 4,
  BLOCK_RANGE_RESPONSE: 6,
  BLOCK: 6,
  PROOF_RESPONSE: 4,
  SNAPSHOT_META_RESPONSE: 4,
  SNAPSHOT_RESPONSE: SNAPSHOT_COMPRESS_LEVEL,
};

const sockets = new Set<WebSocket>();
const outboundUrls = new Set<string>();
const peerBySocket = new Map<WebSocket, string>();
const knownPeers = new Set<string>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const banUntil = new Map<string, number>();
const rateBook = new Map<string, { count: number; windowStart: number }>();
const inboundByIp = new Map<string, number>();
const lastSeenAt = new Map<WebSocket, number>();
const peerTable = new Set<string>();

const recentTxSeen = new Map<string, number>();
const peerKnownTxs = new Map<WebSocket, Map<string, number>>();

const recentBlockSeen = new Map<string, number>();
const peerKnownBlocks = new Map<WebSocket, Map<string, number>>();
const pendingCompactBlocks = new Map<string, PendingCompactBlock>();

const socketOpenedAt = new Map<WebSocket, number>();
const socketDirection = new Map<WebSocket, "inbound" | "outbound">();
const peerLastPingSentAt = new Map<WebSocket, number>();
const peerLatencyMs = new Map<WebSocket, number>();
const peerRemoteHeight = new Map<WebSocket, number>();
const peerRemoteTipHash = new Map<WebSocket, string>();
const peerSyncChunkSize = new Map<WebSocket, number>();
const peerSyncRequestStartedAt = new Map<WebSocket, number>();

let wss: WebSocketServer | null = null;
let tlsHttpsServer: https.Server | null = null;
let p2pTlsConfig: P2PTlsConfig = loadP2PTlsConfig();
let p2pScheme: "ws" | "wss" = "ws";
let localPort = 0;
let localHost = "127.0.0.1";
let advertisedPeerUrl: string | null = null;
let discoveryTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let networkStartedAt = Date.now();
let snapshotLastCompletedAt = 0;

// single active sync owner
let activeSyncPeer: string | null = null;

const snapshotBootstrap: SnapshotBootstrapState = {
  status: "idle",
  peer: null,
  metaReqId: null,
  snapReqId: null,
  meta: null,
  importedHeight: null,
  importedTipHash: null,
  remoteHeight: 0,
  startedAt: 0,
  finishedAt: 0,
  reason: null,
};

const networkStats = {
  messagesReceived: 0,
  messagesSent: 0,
  bytesReceivedApprox: 0,
  bytesSentApprox: 0,
  compressedMessagesReceived: 0,
  compressedMessagesSent: 0,

  discoveryDials: 0,
  heartbeatPingsSent: 0,
  staleSocketsClosed: 0,
  reconnectAttempts: 0,
  reconnectScheduled: 0,
  rateLimitRejects: 0,
  bansIssued: 0,
  badMessages: 0,
  bandwidthInboundAllowed: 0,
  bandwidthInboundRejected: 0,
  bandwidthOutboundAllowed: 0,
  bandwidthOutboundRejected: 0,
  bandwidthBytesDroppedApprox: 0,
  tlsServerEnabled: 0,
  tlsClientDials: 0,
  tlsClientErrors: 0,
  publicSeedDials: 0,
  publicSeedDialErrors: 0,
  checkpointSignaturesCreated: 0,
  checkpointSignaturesVerified: 0,
  checkpointSignatureRejects: 0,
  checkpointUnsignedAccepted: 0,

  headersResponsesSeen: 0,
  blockRangeResponsesSeen: 0,
  initialBlockDownloadRequests: 0,
  initialBlockDownloadBlocks: 0,
  initialBlockDownloadAdaptiveUpshifts: 0,
  initialBlockDownloadAdaptiveDownshifts: 0,
  initialBlockDownloadFastChunks: 0,
  initialBlockDownloadRetryHeaders: 0,
  initialBlockDownloadLastChunkMs: 0,

  txAccepted: 0,
  txRejected: 0,
  txInvReceived: 0,
  txBatchReceived: 0,
  mempoolRequestsSent: 0,
  mempoolResponsesReceived: 0,

  snapshotMetaRequestsSent: 0,
  snapshotMetaResponsesReceived: 0,
  snapshotRequestsSent: 0,
  snapshotResponsesReceived: 0,
  snapshotImportsSucceeded: 0,
  snapshotImportsFailed: 0,
  snapshotResponsePlainSent: 0,
  snapshotResponseCompressedSent: 0,
  snapshotResponseRawBytes: 0,
  snapshotResponsePackedBytes: 0,
  snapshotResponseSavedBytes: 0,
  snapshotResponseCompressionMs: 0,
  snapshotMetaRawBytes: 0,
  snapshotMetaPackedBytes: 0,

  compactReceived: 0,
  compactAccepted: 0,
  compactRejected: 0,
  compactStalled: 0,
  compactRecoveredFromMempool: 0,
  compactTxRequestsSent: 0,
  compactTxsRequested: 0,
  compactTxBatchesReceived: 0,
  compactTxsRecovered: 0,
  compactFullFallbacks: 0,

  fullBlockReceived: 0,
  fullBlockAccepted: 0,
  fullBlockRejected: 0,

  orphanStored: 0,
  orphanResolvedApprox: 0,

  lastHeadersCommonHeight: -1,
  lastHeadersRemoteHeight: -1,
  lastChunkFromHeight: -1,
  lastChunkSize: 0,
  lastChunkAppliedHeight: -1,
  lastChunkAt: 0,
};

function chain() {
  return Chain.instance;
}

function normalizeWsUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    if (!u.hostname) return null;
    const isSecure = u.protocol === "wss:";
    const port = u.port || (isSecure ? "443" : "80");
    return `${isSecure ? "wss" : "ws"}://${u.hostname}:${port}`;
  } catch {
    return null;
  }
}

function now() {
  return Date.now();
}

function readyStateLabel(ws: WebSocket) {
  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return "UNKNOWN";
  }
}

function normalizeHostAlias(host: string): string {
  const h = (host || "").trim().toLowerCase();
  if (!h) return "";
  if (h === "::1") return "127.0.0.1";
  if (h === "[::1]") return "127.0.0.1";
  if (h === "::ffff:127.0.0.1") return "127.0.0.1";
  if (h === "localhost") return "127.0.0.1";
  if (h === "0.0.0.0") return "127.0.0.1";
  if (h === "::") return "127.0.0.1";
  return h;
}

function isLoopbackHost(host: string): boolean {
  const h = normalizeHostAlias(host);
  return h === "127.0.0.1";
}

function localPeerAliases(): Set<string> {
  const out = new Set<string>();
  if (!localPort) return out;

  const hostAliases = new Set<string>([
    normalizeHostAlias(localHost || "127.0.0.1"),
    "127.0.0.1",
    "localhost",
  ]);

  for (const host of hostAliases) {
    if (!host) continue;
    const plain = normalizeWsUrl(`ws://${host}:${localPort}`);
    const secure = normalizeWsUrl(`wss://${host}:${localPort}`);
    if (plain) out.add(plain);
    if (secure) out.add(secure);
  }

  if (advertisedPeerUrl) {
    const adv = normalizeWsUrl(advertisedPeerUrl);
    if (adv) out.add(adv);
  }

  return out;
}

function isSelfPeerUrl(raw: string | null | undefined): boolean {
  const n = normalizeWsUrl(raw || "");
  if (!n) return false;
  return localPeerAliases().has(n);
}

function isSelfSocket(ws: WebSocket): boolean {
  const peer = peerBySocket.get(ws);
  if (peer && isSelfPeerUrl(peer)) return true;

  const ip = normalizeHostAlias(getRemoteIp(ws));
  const port = Number((ws as any)?._socket?.remotePort ?? 0);

  if (port === localPort && isLoopbackHost(ip)) return true;
  if (ip === normalizeHostAlias(localHost) && port === localPort) return true;

  return false;
}

function peerLabel(ws: WebSocket) {
  return peerBySocket.get(ws) || getRemoteIp(ws);
}

function reputationPeerId(ws: WebSocket): string {
  return peerBySocket.get(ws) || getRemoteIp(ws);
}

function reputationEventForBadReason(reason: string): PeerReputationEvent {
  const r = String(reason || "").toLowerCase();

  if (r.includes("rate-limit")) return "rate-limit";
  if (r.includes("envelope")) return "bad-envelope";
  if (r.includes("headers")) return "bad-headers";
  if (r.includes("compact")) return "bad-compact-block";
  if (r.includes("block")) return "bad-block";
  if (r.includes("tx")) return "bad-tx";
  if (r.includes("mempool")) return "bad-mempool-response";
  if (r.includes("proof")) return "bad-proof";
  if (r.includes("snapshot")) return "bad-snapshot";
  if (r.includes("socket")) return "socket-error";
  if (r.includes("timeout")) return "timeout";
  if (r.includes("reputation-ban")) return "manual-ban";

  return "bad-message";
}

function rewardPeer(ws: WebSocket, event: PeerReputationEvent, reason?: string) {
  if (isSelfSocket(ws)) return;
  peerReputation.reward(reputationPeerId(ws), event, reason);
}

function punishPeer(ws: WebSocket, reason: string): PeerReputationSnapshot {
  const peerId = reputationPeerId(ws);
  if (!isSelfSocket(ws)) {
    peerReputation.punish(peerId, reputationEventForBadReason(reason), reason);
  }
  return peerReputation.snapshot(peerId);
}

function reputationSummary() {
  const peers = peerReputation.snapshots();

  return {
    totalTracked: peers.length,
    trusted: peers.filter((p) => p.level === "trusted").length,
    good: peers.filter((p) => p.level === "good").length,
    neutral: peers.filter((p) => p.level === "neutral").length,
    warn: peers.filter((p) => p.level === "warn").length,
    bad: peers.filter((p) => p.level === "bad").length,
    banned: peers.filter((p) => p.level === "banned").length,
    peers,
  };
}

function randomReqId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function makeEnvelope(msg: MsgCore): Envelope {
  return {
    magic: NETWORK_MAGIC,
    chainId: CHAIN_ID,
    version: PROTOCOL_VERSION,
    ...msg,
  };
}

function compressionMinBytesFor(type: MsgCore["type"]) {
  return COMPRESS_MIN_BYTES_BY_TYPE[type] ?? 512;
}

function compressionLevelFor(type: MsgCore["type"]) {
  const lvl = COMPRESS_LEVEL_BY_TYPE[type];
  if (typeof lvl === "number") return Math.max(1, Math.min(9, lvl));
  return 5;
}

function recordSnapshotCompressionStats(args: {
  type: MsgCore["type"];
  rawBytes: number;
  packedBytes: number;
  compressed: boolean;
  elapsedMs: number;
}) {
  if (args.type === "SNAPSHOT_META_RESPONSE") {
    networkStats.snapshotMetaRawBytes += args.rawBytes;
    networkStats.snapshotMetaPackedBytes += args.packedBytes;
    return;
  }

  if (args.type !== "SNAPSHOT_RESPONSE") return;

  networkStats.snapshotResponseRawBytes += args.rawBytes;
  networkStats.snapshotResponsePackedBytes += args.packedBytes;
  networkStats.snapshotResponseCompressionMs += args.elapsedMs;

  if (args.compressed) {
    networkStats.snapshotResponseCompressedSent++;
    networkStats.snapshotResponseSavedBytes += Math.max(0, args.rawBytes - args.packedBytes);
  } else {
    networkStats.snapshotResponsePlainSent++;
  }
}

function maybeCompressEnvelope(msg: MsgCore): Envelope | CompressedEnvelope {
  const plain = makeEnvelope(msg);
  const json = JSON.stringify(plain);
  const rawBytes = Buffer.byteLength(json, "utf8");

  if (!COMPRESSIBLE_TYPES.has(msg.type)) return plain;

  if (rawBytes < compressionMinBytesFor(msg.type)) {
    recordSnapshotCompressionStats({
      type: msg.type,
      rawBytes,
      packedBytes: rawBytes,
      compressed: false,
      elapsedMs: 0,
    });
    return plain;
  }

  const startedAt = Date.now();

  try {
    const gz = zlib.gzipSync(Buffer.from(json, "utf8"), {
      level: compressionLevelFor(msg.type),
    });
    const payloadBase64 = gz.toString("base64");

    const wrapped: CompressedEnvelope = {
      magic: NETWORK_MAGIC,
      chainId: CHAIN_ID,
      version: PROTOCOL_VERSION,
      type: "COMPRESSED",
      codec: "gzip",
      innerType: msg.type,
      payloadBase64,
    };

    const wrappedJson = JSON.stringify(wrapped);
    const packedBytes = Buffer.byteLength(wrappedJson, "utf8");
    const elapsedMs = Math.max(0, Date.now() - startedAt);

    if (packedBytes >= rawBytes) {
      recordSnapshotCompressionStats({
        type: msg.type,
        rawBytes,
        packedBytes: rawBytes,
        compressed: false,
        elapsedMs,
      });
      return plain;
    }

    recordSnapshotCompressionStats({
      type: msg.type,
      rawBytes,
      packedBytes,
      compressed: true,
      elapsedMs,
    });

    const saved = rawBytes - packedBytes;
    const pct = Math.round((saved / rawBytes) * 100);

    if (msg.type === "SNAPSHOT_RESPONSE") {
      const note = rawBytes >= SNAPSHOT_COMPRESS_WARN_RAW_BYTES ? " large-snapshot" : "";
      console.log(
        `🗜️ snapshot compressed${note} | raw=${rawBytes} | packed=${packedBytes} | saved=${saved} (${pct}%) | ms=${elapsedMs}`
      );
    } else {
      console.log(`🗜️ compressed ${msg.type} | raw=${rawBytes} | packed=${packedBytes} | saved=${saved} (${pct}%)`);
    }

    return wrapped;
  } catch (e: any) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    recordSnapshotCompressionStats({
      type: msg.type,
      rawBytes,
      packedBytes: rawBytes,
      compressed: false,
      elapsedMs,
    });
    if (msg.type === "SNAPSHOT_RESPONSE") {
      console.log(`⚠️ snapshot compression failed | raw=${rawBytes} | reason=${e?.message ?? String(e)}`);
    }
    return plain;
  }
}

function send(ws: WebSocket, msg: MsgCore) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    const payload = maybeCompressEnvelope(msg);
    const text = JSON.stringify(payload);
    const bytes = Buffer.byteLength(text, "utf8");

    const throttle = bandwidthThrottle.allowOutbound(peerLabel(ws), bytes);
    if (!throttle.allowed) {
      networkStats.bandwidthOutboundRejected++;
      networkStats.bandwidthBytesDroppedApprox += bytes;
      console.log(
        `🚦 outbound bandwidth throttle peer=${peerLabel(ws)} type=${msg.type} bytes=${bytes} reason=${throttle.reason}`
      );
      return;
    }

    networkStats.bandwidthOutboundAllowed++;
    networkStats.messagesSent++;
    networkStats.bytesSentApprox += bytes;
    if ((payload as any).type === "COMPRESSED") {
      networkStats.compressedMessagesSent++;
    }
    if (msg.type === "MEMPOOL_REQUEST") {
      networkStats.mempoolRequestsSent++;
    }
    if (msg.type === "SNAPSHOT_META_REQUEST") {
      networkStats.snapshotMetaRequestsSent++;
    }
    if (msg.type === "SNAPSHOT_REQUEST") {
      networkStats.snapshotRequestsSent++;
    }

    ws.send(text);
  } catch {}
}

function blockByHash(hash: string): Block | null {
  if (typeof hash !== "string" || !hash) return null;
  for (let i = chain().blocks.length - 1; i >= 0; i--) {
    if (chain().blocks[i].hash === hash) return chain().blocks[i];
  }
  return null;
}

function hasBlock(hash: string): boolean {
  return blockByHash(hash) !== null;
}

function heightOfHash(hash: string): number {
  for (let i = chain().blocks.length - 1; i >= 0; i--) {
    if (chain().blocks[i].hash === hash) return i;
  }
  return -1;
}

function compactFromBlock(block: Block, height: number): CompactBlockJson {
  return {
    hash: block.hash,
    prevHash: block.prevHash,
    ts: block.ts,
    nonce: block.nonce,
    difficulty: block.difficulty,
    stateRoot: block.stateRoot,
    height,
    coinbase: block.txs[0]?.toJSON() ?? null,
    txIds: block.txs.slice(1).map((t) => t.id),
  };
}

function isReqId(x: any) {
  return typeof x === "string" && x.length > 0 && x.length <= MAX_REQ_ID_LEN;
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

function buildLiveSnapshot(): SnapshotJson {
  const exported = chain().exportCheckpointSnapshot();
  if (exported) {
    const signed = signBootstrapCheckpoint(exported as SnapshotJson) as SnapshotJson;
    if (signed.checkpointSignature) networkStats.checkpointSignaturesCreated++;
    return signed;
  }

  const st = chain().getState();
  const tip = chain().blocks[chain().blocks.length - 1];
  const snapshot: SnapshotJson = {
    height: chain().height(),
    tipHash: tip.hash,
    stateRoot: tip.stateRoot,
    minted: st.minted,
    balances: mapNumToObj(st.balances as Map<string, number>),
    nonces: mapNumToObj(st.nonces as Map<string, number>),
    pending: pendingMapToObj(st.pending as Map<string, Array<{ amount: number; unlockHeight: number }>>),
    createdAt: Date.now(),
  };

  const signed = signBootstrapCheckpoint(snapshot) as SnapshotJson;
  if (signed.checkpointSignature) networkStats.checkpointSignaturesCreated++;
  return signed;
}

function buildLiveSnapshotMeta(): SnapshotMetaJson {
  const snap = buildLiveSnapshot();
  const pendingAccounts = Object.keys(snap.pending).length;
  let pendingRewards = 0;
  for (const arr of Object.values(snap.pending)) pendingRewards += arr.length;
  const meta: SnapshotMetaJson = {
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

  const signed = signBootstrapCheckpoint(meta) as SnapshotMetaJson;
  if (signed.checkpointSignature) networkStats.checkpointSignaturesCreated++;
  return signed;
}

function estimateSnapshotPayloadBytes(snapshot: SnapshotJson): number {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}


function localSnapshotBootstrapEligible() {
  return !chain().hasCheckpoint() && chain().height() <= 0;
}

function snapshotMetaBasicValid(snap: SnapshotMetaJson | null | undefined): snap is SnapshotMetaJson {
  if (!snap || typeof snap !== "object") return false;
  if (!Number.isFinite(snap.height) || snap.height < 0) return false;
  if (typeof snap.tipHash !== "string" || !snap.tipHash) return false;
  if (typeof snap.stateRoot !== "string" || !snap.stateRoot) return false;
  if (!Number.isFinite(snap.minted) || snap.minted < 0) return false;
  if (!Number.isFinite(snap.balancesCount) || snap.balancesCount < 0) return false;
  if (!Number.isFinite(snap.noncesCount) || snap.noncesCount < 0) return false;
  if (!Number.isFinite(snap.pendingAccounts) || snap.pendingAccounts < 0) return false;
  if (!Number.isFinite(snap.pendingRewards) || snap.pendingRewards < 0) return false;
  if (!Number.isFinite(snap.createdAt) || snap.createdAt <= 0) return false;
  return true;
}

function validateSnapshotMetaTrustRules(snap: SnapshotMetaJson): { ok: boolean; reason?: string } {
  if (!snapshotMetaBasicValid(snap)) return { ok: false, reason: "bad-meta-shape" };

  const sig = verifyBootstrapCheckpointSignature(snap);
  if (!sig.ok) return { ok: false, reason: sig.reason };

  const localHeight = chain().height();
  const remoteAhead = snap.height - localHeight;

  if (!localSnapshotBootstrapEligible()) {
    return { ok: false, reason: "local-not-eligible" };
  }

  if (snap.height < SNAPSHOT_MIN_REMOTE_AHEAD) {
    return { ok: false, reason: `remote-too-short height=${snap.height}` };
  }

  if (remoteAhead < SNAPSHOT_MIN_GAIN_OVER_LOCAL) {
    return { ok: false, reason: `remote-not-meaningfully-ahead delta=${remoteAhead}` };
  }

  const age = now() - snap.createdAt;
  if (age > SNAPSHOT_META_MAX_AGE_MS) {
    return { ok: false, reason: `snapshot-meta-stale ageMs=${age}` };
  }

  return { ok: true };
}

function validateSnapshotPayloadTrustRules(
  snap: SnapshotJson,
  expectedMeta: SnapshotMetaJson | null
): { ok: boolean; reason?: string } {
  if (!snap || typeof snap !== "object") return { ok: false, reason: "bad-snapshot-shape" };
  if (!Number.isFinite(snap.height) || snap.height < 0) return { ok: false, reason: "bad-snapshot-height" };
  if (typeof snap.tipHash !== "string" || !snap.tipHash) return { ok: false, reason: "bad-snapshot-tipHash" };
  if (typeof snap.stateRoot !== "string" || !snap.stateRoot) return { ok: false, reason: "bad-snapshot-stateRoot" };
  if (!snap.balances || typeof snap.balances !== "object") return { ok: false, reason: "bad-snapshot-balances" };
  if (!snap.nonces || typeof snap.nonces !== "object") return { ok: false, reason: "bad-snapshot-nonces" };
  if (!snap.pending || typeof snap.pending !== "object") return { ok: false, reason: "bad-snapshot-pending" };

  const sig = verifyBootstrapCheckpointSignature(snap);
  if (!sig.ok) return { ok: false, reason: sig.reason };

  if (expectedMeta) {
    if (snap.height !== expectedMeta.height) return { ok: false, reason: "snapshot-meta-height-mismatch" };
    if (snap.tipHash !== expectedMeta.tipHash) return { ok: false, reason: "snapshot-meta-tipHash-mismatch" };
    if (snap.stateRoot !== expectedMeta.stateRoot) return { ok: false, reason: "snapshot-meta-stateRoot-mismatch" };
    if ((snap.minted ?? 0) !== expectedMeta.minted) return { ok: false, reason: "snapshot-meta-minted-mismatch" };

    const balancesCount = Object.keys(snap.balances).length;
    const noncesCount = Object.keys(snap.nonces).length;
    const pendingAccounts = Object.keys(snap.pending).length;
    let pendingRewards = 0;
    for (const arr of Object.values(snap.pending)) {
      if (!Array.isArray(arr)) return { ok: false, reason: "snapshot-pending-array-shape" };
      pendingRewards += arr.length;
    }

    if (balancesCount !== expectedMeta.balancesCount) {
      return { ok: false, reason: "snapshot-meta-balancesCount-mismatch" };
    }
    if (noncesCount !== expectedMeta.noncesCount) {
      return { ok: false, reason: "snapshot-meta-noncesCount-mismatch" };
    }
    if (pendingAccounts !== expectedMeta.pendingAccounts) {
      return { ok: false, reason: "snapshot-meta-pendingAccounts-mismatch" };
    }
    if (pendingRewards !== expectedMeta.pendingRewards) {
      return { ok: false, reason: "snapshot-meta-pendingRewards-mismatch" };
    }
  }

  return { ok: true };
}

function resetSnapshotBootstrap(reason: string) {
  const peer = snapshotBootstrap.peer;
  const importedHeight = snapshotBootstrap.importedHeight;
  const remoteHeight = snapshotBootstrap.remoteHeight;

  if (snapshotBootstrap.status !== "idle") {
    console.log(
      `🧹 snapshot bootstrap reset | reason=${reason}` +
        (peer ? ` | peer=${peer}` : "") +
        (importedHeight !== null ? ` | importedHeight=${importedHeight}` : "") +
        (remoteHeight > 0 ? ` | remoteHeight=${remoteHeight}` : "")
    );
  }

  snapshotBootstrap.status = "idle";
  snapshotBootstrap.peer = null;
  snapshotBootstrap.metaReqId = null;
  snapshotBootstrap.snapReqId = null;
  snapshotBootstrap.meta = null;
  snapshotBootstrap.importedHeight = null;
  snapshotBootstrap.importedTipHash = null;
  snapshotBootstrap.remoteHeight = 0;
  snapshotBootstrap.startedAt = 0;
  snapshotBootstrap.finishedAt = Date.now();
  snapshotBootstrap.reason = reason;
}

function shouldTrySnapshotBootstrap(remoteHeight: number) {
  if (!localSnapshotBootstrapEligible()) return false;
  if (snapshotBootstrap.status !== "idle") return false;
  return remoteHeight >= SNAPSHOT_MIN_REMOTE_AHEAD;
}

function requestSnapshotMeta(ws: WebSocket, reason: string) {
  if (!localSnapshotBootstrapEligible()) {
    console.log(`📸 snapshot meta skipped ${peerLabel(ws)} | reason=local-not-eligible | trigger=${reason}`);
    return;
  }

  const reqId = randomReqId("snapmeta");

  snapshotBootstrap.status = "waiting-meta";
  snapshotBootstrap.peer = peerLabel(ws);
  snapshotBootstrap.metaReqId = reqId;
  snapshotBootstrap.snapReqId = null;
  snapshotBootstrap.meta = null;
  snapshotBootstrap.importedHeight = null;
  snapshotBootstrap.importedTipHash = null;
  snapshotBootstrap.remoteHeight = 0;
  snapshotBootstrap.startedAt = Date.now();
  snapshotBootstrap.finishedAt = 0;
  snapshotBootstrap.reason = null;

  send(ws, { type: "SNAPSHOT_META_REQUEST", reqId });
  console.log(`📸 snapshot meta request out:${peerLabel(ws)} | reqId=${reqId} | reason=${reason}`);
}

function maybeStartSnapshotBootstrap(ws: WebSocket, remoteHeight: number, reason: string) {
  const peer = peerLabel(ws);

  if (!shouldTrySnapshotBootstrap(remoteHeight)) {
    console.log(
      `📸 snapshot bootstrap skipped ${peer} | reason=not-eligible | localHeight=${chain().height()} | remoteHeight=${remoteHeight} | trigger=${reason}`
    );
    return;
  }

  const trust = snapshotBootstrap.meta
    ? validateSnapshotMetaTrustRules(snapshotBootstrap.meta)
    : { ok: false, reason: "missing-meta" };
  if (!trust.ok) {
    console.log(
      `📸 snapshot bootstrap skipped ${peer} | reason=${trust.reason} | localHeight=${chain().height()} | remoteHeight=${remoteHeight} | trigger=${reason}`
    );
    resetSnapshotBootstrap(trust.reason || "meta-trust-rejected");
    return;
  }

  const reqId = randomReqId("snap");

  snapshotBootstrap.status = "waiting-snapshot";
  snapshotBootstrap.peer = peer;
  snapshotBootstrap.snapReqId = reqId;
  snapshotBootstrap.remoteHeight = remoteHeight;
  snapshotBootstrap.importedHeight = null;
  snapshotBootstrap.importedTipHash = null;

  send(ws, { type: "SNAPSHOT_REQUEST", reqId });
  console.log(
    `⚡ snapshot bootstrap request out:${peer} | reqId=${reqId} | remoteHeight=${remoteHeight} | localHeight=${chain().height()} | reason=${reason}`
  );
}

function maybeContinueSyncFromImportedSnapshot(ws: WebSocket) {
  if (snapshotBootstrap.status !== "ready") return;
  if (snapshotBootstrap.importedHeight === null) return;

  const peer = peerLabel(ws);
  const remoteHeight =
    snapshotBootstrap.remoteHeight || snapshotBootstrap.meta?.height || snapshotBootstrap.importedHeight;
  const importedHeight = snapshotBootstrap.importedHeight;

  console.log(`⚡ snapshot bootstrap ready ${peer} | importedHeight=${importedHeight} | remoteHeight=${remoteHeight}`);

  if (remoteHeight <= importedHeight) {
    snapshotLastCompletedAt = Date.now();
    resetSnapshotBootstrap("no-tail-needed");
    maybeRequestMempool(ws, "snapshot-bootstrap-complete");
    console.log(`✅ snapshot-bootstrap-complete | height=${chain().height()}`);
    return;
  }

  const from = importedHeight + 1;
  const remaining = Math.max(0, remoteHeight - importedHeight);
  const want = Math.min(REQUEST_CHUNK_SIZE, remaining);

  console.log(`🔁 snapshot imported, requesting tail | localHeight=${chain().height()} | remoteHeight=${remoteHeight}`);
  console.log(`📦 request chunk out:${peer} | from=${from} | count=${want} | remaining=${remaining}`);

  send(ws, { type: "BLOCK_RANGE_REQUEST", fromHeight: from, maxCount: want });
  snapshotLastCompletedAt = Date.now();
  resetSnapshotBootstrap("tail-sync-started");
}

function buildProofResponse(
  kind: ProofKind,
  reqId: string,
  args: {
    address?: string | null;
    pendingIndex?: number | null;
    proof?: any | null;
    error?: string;
  }
): Extract<MsgCore, { type: "PROOF_RESPONSE" }> {
  if (!args.proof) {
    return {
      type: "PROOF_RESPONSE",
      kind,
      reqId,
      address: args.address ?? null,
      pendingIndex: args.pendingIndex ?? null,
      ok: false,
      verified: false,
      error: args.error || "proof not available",
    };
  }

  return {
    type: "PROOF_RESPONSE",
    kind,
    reqId,
    address: args.address ?? null,
    pendingIndex: args.pendingIndex ?? null,
    ok: true,
    verified: verifyStateProof(args.proof),
    proof: args.proof,
  };
}

function handleSnapshotMetaRequest(ws: WebSocket, reqId: string) {
  const peer = peerLabel(ws);

  if (!isReqId(reqId)) {
    markBad(ws, "bad-snapshot-meta-reqid");
    return;
  }

  const meta = buildLiveSnapshotMeta();
  send(ws, {
    type: "SNAPSHOT_META_RESPONSE",
    reqId,
    ok: true,
    snapshot: meta,
  });

  console.log(
    `📸 snapshot meta response ${peer} | reqId=${reqId} | height=${meta.height} | balances=${meta.balancesCount} | pendingRewards=${meta.pendingRewards}`
  );
}

function handleSnapshotRequest(ws: WebSocket, reqId: string) {
  const peer = peerLabel(ws);

  if (!isReqId(reqId)) {
    markBad(ws, "bad-snapshot-reqid");
    return;
  }

  const snapshot = buildLiveSnapshot();
  const rawBytes = estimateSnapshotPayloadBytes(snapshot);
  const shouldCompress = rawBytes >= SNAPSHOT_COMPRESS_MIN_BYTES;

  send(ws, {
    type: "SNAPSHOT_RESPONSE",
    reqId,
    ok: true,
    snapshot,
  });

  console.log(
    `📸 snapshot response ${peer} | reqId=${reqId} | height=${snapshot.height} | balances=${Object.keys(
      snapshot.balances
    ).length} | rawBytes=${rawBytes} | compress=${shouldCompress}`
  );
}

function handleSnapshotMetaResponse(ws: WebSocket, msg: Extract<MsgCore, { type: "SNAPSHOT_META_RESPONSE" }>) {
  const peer = peerLabel(ws);
  networkStats.snapshotMetaResponsesReceived++;

  if (!msg.ok) {
    console.log(`📸 snapshot meta error ${peer} | ${msg.error ?? "unknown"}`);
    if (snapshotBootstrap.peer === peer && snapshotBootstrap.metaReqId === msg.reqId) {
      resetSnapshotBootstrap("peer-meta-error");
    }
    return;
  }

  const snap = msg.snapshot;
  if (!snap) {
    console.log(`📸 snapshot meta missing ${peer}`);
    if (snapshotBootstrap.peer === peer && snapshotBootstrap.metaReqId === msg.reqId) {
      resetSnapshotBootstrap("missing-meta");
    }
    return;
  }

  if (
    snapshotBootstrap.status !== "waiting-meta" ||
    snapshotBootstrap.metaReqId !== msg.reqId ||
    snapshotBootstrap.peer !== peer
  ) {
    console.log(`⚠️ snapshot meta recv ignored ${peer} | reqId=${msg.reqId}`);
    return;
  }

  if (!snapshotMetaBasicValid(snap)) {
    console.log(`📸 snapshot meta reject ${peer} | reqId=${msg.reqId} | reason=bad-meta-shape`);
    resetSnapshotBootstrap("bad-meta-shape");
    return;
  }

  const metaSig = verifyBootstrapCheckpointSignature(snap);
  if (metaSig.ok && metaSig.signed) networkStats.checkpointSignaturesVerified++;
  else if (metaSig.ok && !metaSig.signed) networkStats.checkpointUnsignedAccepted++;
  else networkStats.checkpointSignatureRejects++;

  snapshotBootstrap.meta = snap;
  snapshotBootstrap.remoteHeight = snap.height;
  peerRemoteHeight.set(ws, snap.height);
  peerRemoteTipHash.set(ws, snap.tipHash);

  console.log(
    `📸 snapshot meta recv ${peer} | reqId=${msg.reqId} | height=${snap.height} | balances=${snap.balancesCount} | pendingRewards=${snap.pendingRewards}`
  );

  const trust = validateSnapshotMetaTrustRules(snap);
  if (!trust.ok) {
    console.log(
      `📸 snapshot meta skip ${peer} | reqId=${msg.reqId} | reason=${trust.reason} | localHeight=${chain().height()} | remoteHeight=${snap.height}`
    );
    resetSnapshotBootstrap(trust.reason || "meta-trust-rejected");
    return;
  }

  maybeStartSnapshotBootstrap(ws, snap.height, "meta-received");
}

function handleSnapshotResponse(ws: WebSocket, msg: Extract<MsgCore, { type: "SNAPSHOT_RESPONSE" }>) {
  const peer = peerLabel(ws);
  networkStats.snapshotResponsesReceived++;

  if (!msg.ok) {
    console.log(`📸 snapshot error ${peer} | ${msg.error ?? "unknown"}`);
    if (snapshotBootstrap.snapReqId === msg.reqId) resetSnapshotBootstrap("peer-snapshot-error");
    return;
  }

  const snap = msg.snapshot;
  if (!snap) {
    console.log(`📸 snapshot missing ${peer}`);
    if (snapshotBootstrap.snapReqId === msg.reqId) resetSnapshotBootstrap("missing-snapshot");
    return;
  }

  console.log(
    `📸 snapshot recv ${peer} | reqId=${msg.reqId} | height=${snap.height} | balances=${Object.keys(
      snap.balances
    ).length} | stateRoot=${snap.stateRoot.slice(0, 16)}...`
  );

  if (
    snapshotBootstrap.status !== "waiting-snapshot" ||
    snapshotBootstrap.snapReqId !== msg.reqId ||
    snapshotBootstrap.peer !== peer
  ) {
    console.log(`⚠️ snapshot recv ignored ${peer} | reqId=${msg.reqId}`);
    return;
  }

  const snapSig = verifyBootstrapCheckpointSignature(snap);
  if (snapSig.ok && snapSig.signed) networkStats.checkpointSignaturesVerified++;
  else if (snapSig.ok && !snapSig.signed) networkStats.checkpointUnsignedAccepted++;
  else networkStats.checkpointSignatureRejects++;

  const trust = validateSnapshotPayloadTrustRules(snap, snapshotBootstrap.meta);
  if (!trust.ok) {
    networkStats.snapshotImportsFailed++;
    console.log(`📸 snapshot reject ${peer} | reqId=${msg.reqId} | reason=${trust.reason}`);
    resetSnapshotBootstrap(trust.reason || "snapshot-trust-rejected");
    return;
  }

  const ok = chain().importCheckpointSnapshot(snap);
  if (!ok) {
    networkStats.snapshotImportsFailed++;
    resetSnapshotBootstrap("import-failed");
    return;
  }

  networkStats.snapshotImportsSucceeded++;
  rewardPeer(ws, "snapshot-ok", "snapshot-imported");
  snapshotBootstrap.status = "ready";
  snapshotBootstrap.importedHeight = snap.height;
  snapshotBootstrap.importedTipHash = snap.tipHash;
  snapshotBootstrap.finishedAt = Date.now();

  console.log(
    `⚡ imported checkpoint | height=${snap.height} | tip=${snap.tipHash.slice(0, 12)}... | stateRoot=${snap.stateRoot.slice(
      0,
      12
    )}...`
  );

  maybeContinueSyncFromImportedSnapshot(ws);
}

function handleProofRequest(ws: WebSocket, kind: ProofKind, reqId: string, address?: string, pendingIndex?: number) {
  const peer = peerLabel(ws);

  if (!isReqId(reqId)) {
    markBad(ws, "bad-proof-reqid");
    return;
  }

  let out: Extract<MsgCore, { type: "PROOF_RESPONSE" }>;

  if (kind === "minted") {
    out = buildProofResponse("minted", reqId, {
      proof: chain().getMintedProof(),
    });
    send(ws, out);
    console.log(`🧾 proof response ${peer} | kind=minted | ok=${out.ok}`);
    return;
  }

  if (typeof address !== "string" || !address) {
    out = buildProofResponse(kind, reqId, {
      address: null,
      pendingIndex: pendingIndex ?? null,
      error: "missing address",
    });
    send(ws, out);
    console.log(`🧾 proof response ${peer} | kind=${kind} | ok=false`);
    return;
  }

  if (kind === "balance") {
    out = buildProofResponse("balance", reqId, {
      address,
      proof: chain().getBalanceProof(address),
    });
    send(ws, out);
    console.log(`🧾 proof response ${peer} | kind=balance | ok=${out.ok}`);
    return;
  }

  if (kind === "nonce") {
    out = buildProofResponse("nonce", reqId, {
      address,
      proof: chain().getNonceProof(address),
    });
    send(ws, out);
    console.log(`🧾 proof response ${peer} | kind=nonce | ok=${out.ok}`);
    return;
  }

  if (kind === "pending") {
    const idx = typeof pendingIndex === "number" && Number.isFinite(pendingIndex) ? pendingIndex : 0;
    out = buildProofResponse("pending", reqId, {
      address,
      pendingIndex: idx,
      proof: chain().getPendingProof(address, idx),
    });
    send(ws, out);
    console.log(`🧾 proof response ${peer} | kind=pending | index=${idx} | ok=${out.ok}`);
    return;
  }

  markBad(ws, "bad-proof-kind");
}

function handleProofResponse(ws: WebSocket, msg: Extract<MsgCore, { type: "PROOF_RESPONSE" }>) {
  const peer = peerLabel(ws);
  console.log(`proof recv ${peer} | kind=${msg.kind} | reqId=${msg.reqId} | ok=${msg.ok} | verified=${msg.verified}`);

  if (!msg.ok) {
    console.log(`proof error ${peer} | ${msg.error ?? "unknown"}`);
    return;
  }

  if (msg.ok && msg.verified) {
    rewardPeer(ws, "proof-ok", "verified-proof");
  }

  if (msg.proof && typeof msg.proof === "object") {
    console.log(JSON.stringify(msg, null, 2));
  }
}

function currentBestRemoteHeight(): number {
  let best = chain().height();
  for (const h of peerRemoteHeight.values()) {
    if (typeof h === "number" && Number.isFinite(h) && h > best) best = h;
  }
  return best;
}

function localNeedsSync(): boolean {
  return currentBestRemoteHeight() > chain().height();
}

function isSyncOwner(ws: WebSocket): boolean {
  return !!activeSyncPeer && activeSyncPeer === peerLabel(ws);
}

function acquireSyncOwner(ws: WebSocket, reason: string): boolean {
  const peer = peerLabel(ws);

  if (!activeSyncPeer) {
    activeSyncPeer = peer;
    console.log(`🔒 sync owner set ${peer} | reason=${reason}`);
    return true;
  }

  if (activeSyncPeer === peer) return true;

  console.log(`⏭️ sync owner busy ${peer} | owner=${activeSyncPeer} | reason=${reason}`);
  return false;
}

function releaseSyncOwner(reason: string) {
  if (!activeSyncPeer) return;
  console.log(`🔓 sync owner cleared ${activeSyncPeer} | reason=${reason}`);
  activeSyncPeer = null;
}

export function broadcastBlock(block: Block) {
  rememberRecentBlock(block.hash);
  console.log(`📣 local block announce ${shortHash(block.hash)} peers=${sockets.size} height=${chain().height()}`);
  announceBlock(block.hash, chain().height());
}

export function broadcastTx(tx: Tx) {
  rememberRecentTx(tx.id);
  console.log(`📣 local tx announce ${shortHash(tx.id)} peers=${sockets.size}`);
  announceTxIds([tx.id]);
}

function shortHash(s: string) {
  return s.slice(0, 12) + "...";
}

function peerTableFile() {
  return localPort ? `dubzchain.${localPort}.peers.json` : "dubzchain.peers.json";
}

function savePeerTable() {
  try {
    const peers = Array.from(peerTable).filter((p) => !isSelfPeerUrl(p)).slice(0, PEER_TABLE_MAX);
    fs.writeFileSync(peerTableFile(), JSON.stringify({ peers, savedAt: now() }, null, 2), "utf8");
    console.log(`💾 saved peer table ${peerTableFile()} | peers=${peers.length}`);
  } catch {}
}

function loadPeerTable() {
  try {
    const raw = JSON.parse(fs.readFileSync(peerTableFile(), "utf8"));
    const peers = Array.isArray(raw?.peers) ? raw.peers : [];
    let learned = 0;
    let skippedSelf = 0;

    for (const p of peers) {
      const n = normalizeWsUrl(p);
      if (!n) continue;
      if (isSelfPeerUrl(n)) {
        skippedSelf++;
        continue;
      }
      if (!peerTable.has(n)) learned++;
      peerTable.add(n);
      knownPeers.add(n);
    }

    console.log(
      `📚 loaded peer table ${peerTableFile()} | learned=${learned} | skippedSelf=${skippedSelf} | known=${knownPeers.size}`
    );
  } catch {}
}

function rememberPeer(url: string) {
  const n = normalizeWsUrl(url);
  if (!n) return;
  if (isSelfPeerUrl(n)) return;
  peerTable.add(n);
  knownPeers.add(n);
  while (peerTable.size > PEER_TABLE_MAX) {
    const first = peerTable.values().next();
    if (first.done) break;
    peerTable.delete(first.value);
  }
  savePeerTable();
}

function getRemoteIp(ws: WebSocket): string {
  const sock: any = (ws as any)._socket;
  return sock?.remoteAddress || "unknown";
}

function banned(ip: string) {
  const until = banUntil.get(ip) ?? 0;
  if (until <= now()) {
    banUntil.delete(ip);
    return false;
  }
  return true;
}

function markBad(ws: WebSocket, reason: string) {
  networkStats.bansIssued++;
  if (reason === "bad-message") networkStats.badMessages++;

  if (isSelfSocket(ws)) {
    console.log(`↪️ self-peer close ${peerLabel(ws)} reason=${reason}`);
    try {
      ws.close(1000, "self-peer");
    } catch {}
    return;
  }

  const rep = punishPeer(ws, reason);
  const ip = getRemoteIp(ws);

  const repBanActive = !!rep && rep.isBanned;
  const oldBanMs = 60_000;
  const repBanMs = repBanActive ? rep.banRemainingMs : oldBanMs;
  const banMs = Math.max(oldBanMs, repBanMs);

  banUntil.set(ip, now() + banMs);

  console.log(
    `🚫 banned ip=${ip} reason=${reason} reputation=${rep.level} score=${rep.score} banMs=${banMs}`
  );

  try {
    ws.close(1008, reason);
  } catch {}
}

function allowByRate(ws: WebSocket) {
  if (isSelfSocket(ws)) return true;

  const peerId = reputationPeerId(ws);
  if (peerReputation.isBanned(peerId)) {
    const snap = peerReputation.snapshot(peerId);
    networkStats.rateLimitRejects++;
    console.log(
      `🚫 inbound reject reputation-ban peer=${peerId} level=${snap.level} score=${snap.score} remainingMs=${snap.banRemainingMs}`
    );
    markBad(ws, "reputation-ban");
    return false;
  }

  const ip = getRemoteIp(ws);
  const cur = rateBook.get(ip) ?? { count: 0, windowStart: now() };
  if (now() - cur.windowStart > RATE_WINDOW_MS) {
    cur.count = 0;
    cur.windowStart = now();
  }
  cur.count++;
  rateBook.set(ip, cur);
  if (cur.count > RATE_LIMIT_COUNT) {
    networkStats.rateLimitRejects++;
    console.log(`🚫 inbound reject rate-limit ip=${ip} count=${cur.count}`);
    markBad(ws, "rate-limit");
    return false;
  }
  return true;
}

function isCompressedEnvelope(msg: any): msg is CompressedEnvelope {
  return (
    !!msg &&
    typeof msg === "object" &&
    msg.magic === NETWORK_MAGIC &&
    msg.chainId === CHAIN_ID &&
    msg.version === PROTOCOL_VERSION &&
    msg.type === "COMPRESSED" &&
    msg.codec === "gzip" &&
    typeof msg.innerType === "string" &&
    typeof msg.payloadBase64 === "string"
  );
}

function validateEnvelopeShape(msg: any): msg is Envelope {
  if (!msg || typeof msg !== "object") return false;
  if (msg.magic !== NETWORK_MAGIC) return false;
  if (msg.chainId !== CHAIN_ID) return false;
  if (msg.version !== PROTOCOL_VERSION) return false;
  if (typeof msg.type !== "string") return false;
  if (msg.type === "COMPRESSED") return false;
  return true;
}

function isValidHeader(h: any): h is BlockHeader {
  return (
    !!h &&
    typeof h.hash === "string" &&
    typeof h.prevHash === "string" &&
    typeof h.ts === "number" &&
    typeof h.nonce === "number" &&
    typeof h.difficulty === "number" &&
    typeof h.txRoot === "string" &&
    typeof h.stateRoot === "string"
  );
}

function validateHeaderCommitments(headers: BlockHeader[]): boolean {
  if (!headers.length) return true;
  if (headers[0].hash === GENESIS_HASH) {
    if (headers[0].prevHash !== "") return false;
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!isValidHeader(h)) return false;
    if (h.hash !== computeHeaderHash(h)) return false;
    if (h.difficulty < MIN_DIFFICULTY || h.difficulty > MAX_DIFFICULTY) return false;
    if (i > 0 && headers[i].prevHash !== headers[i - 1].hash) return false;
  }
  return true;
}

function commonHeaderHeight(local: BlockHeader[], remote: BlockHeader[]): number {
  const n = Math.min(local.length, remote.length);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (local[i].hash !== remote[i].hash) break;
    last = i;
  }
  return last;
}

function scheduleReconnect(url: string, attempt: number) {
  const n = normalizeWsUrl(url);
  if (!n) return;
  if (isSelfPeerUrl(n)) return;
  if (reconnectTimers.has(n)) return;

  networkStats.reconnectScheduled++;
  const delay = Math.min(1000 * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY_MS);
  console.log(`🔁 reconnect scheduled ${n} in ${delay}ms (attempt ${attempt})`);

  const t = setTimeout(() => {
    reconnectTimers.delete(n);
    connectToPeer(n, undefined, attempt);
  }, delay);

  reconnectTimers.set(n, t);
}

function clearReconnect(url: string) {
  const n = normalizeWsUrl(url);
  if (!n) return;
  const t = reconnectTimers.get(n);
  if (t) clearTimeout(t);
  reconnectTimers.delete(n);
}

function maybeRequestMempool(ws: WebSocket, reason: string) {
  send(ws, { type: "MEMPOOL_REQUEST", reason });
  console.log(`🧰 mempool request out:${peerLabel(ws)} | reason=${reason}`);
}

function pruneRecentTxSeen() {
  const cutoff = now() - RECENT_TX_TTL_MS;
  for (const [txId, seenAt] of recentTxSeen.entries()) {
    if (seenAt < cutoff) recentTxSeen.delete(txId);
  }
  while (recentTxSeen.size > RECENT_TX_CACHE_MAX) {
    const first = recentTxSeen.keys().next();
    if (first.done) break;
    recentTxSeen.delete(first.value);
  }
}

function rememberRecentTx(txId: string) {
  if (!txId) return;
  recentTxSeen.set(txId, now());
  pruneRecentTxSeen();
}

function hasRecentTx(txId: string) {
  pruneRecentTxSeen();
  const seenAt = recentTxSeen.get(txId);
  if (!seenAt) return false;
  if (seenAt < now() - RECENT_TX_TTL_MS) {
    recentTxSeen.delete(txId);
    return false;
  }
  return true;
}

function getPeerKnownSet(ws: WebSocket) {
  let m = peerKnownTxs.get(ws);
  if (!m) {
    m = new Map<string, number>();
    peerKnownTxs.set(ws, m);
  }
  return m;
}

function prunePeerKnownSet(ws: WebSocket) {
  const m = getPeerKnownSet(ws);
  const cutoff = now() - RECENT_TX_TTL_MS;
  for (const [txId, seenAt] of m.entries()) {
    if (seenAt < cutoff) m.delete(txId);
  }
  while (m.size > PEER_KNOWN_TX_MAX) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
}

function markPeerKnowsTx(ws: WebSocket, txId: string) {
  if (!txId) return;
  const m = getPeerKnownSet(ws);
  m.set(txId, now());
  prunePeerKnownSet(ws);
}

function markPeerKnowsTxs(ws: WebSocket, txIds: string[]) {
  for (const txId of txIds) {
    if (typeof txId === "string" && txId) markPeerKnowsTx(ws, txId);
  }
}

function peerKnowsTx(ws: WebSocket, txId: string) {
  prunePeerKnownSet(ws);
  return getPeerKnownSet(ws).has(txId);
}

function announceTxIds(txIds: string[], except?: WebSocket) {
  const cleanIds = Array.from(new Set(txIds.filter((x) => typeof x === "string" && !!x).slice(0, MAX_TX_INV_IDS)));
  if (!cleanIds.length) return;

  for (const txId of cleanIds) rememberRecentTx(txId);

  let announcedPeers = 0;
  for (const ws of sockets) {
    if (except && ws === except) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;

    const need: string[] = [];
    for (const txId of cleanIds) {
      if (peerKnowsTx(ws, txId)) continue;
      need.push(txId);
    }

    if (!need.length) continue;

    for (const txId of need) markPeerKnowsTx(ws, txId);
    send(ws, { type: "TX_INV", txIds: need });
    announcedPeers++;
    console.log(`📣 tx inv sent ${peerLabel(ws)} | count=${need.length} | ids=${need.map(shortHash).join(",")}`);
  }

  console.log(`📣 tx inv summary | peers=${announcedPeers} | ids=${cleanIds.length}`);
}

function collectMissingTxIds(txIds: string[]): string[] {
  const missing: string[] = [];
  for (const txId of txIds) {
    if (typeof txId !== "string" || !txId) continue;
    if (chain().mempool.has(txId)) continue;
    if (hasRecentTx(txId)) continue;
    missing.push(txId);
    rememberRecentTx(txId);
    if (missing.length >= MAX_TX_GET_IDS) break;
  }
  return missing;
}

function applyOrphanDelta(before: number, after: number, accepted: boolean) {
  if (!accepted && after > before) {
    networkStats.orphanStored += after - before;
  }
  if (accepted && before > after) {
    networkStats.orphanResolvedApprox += before - after;
  }
}

function handleTxAccept(ws: WebSocket | undefined, tx: Tx): boolean {
  const ok = chain().addToMempool(tx);
  if (!ok) {
    networkStats.txRejected++;
    console.log(`❌ tx rejected ${shortHash(tx.id)} from=${ws ? peerLabel(ws) : "local"}`);
    return false;
  }

  networkStats.txAccepted++;
  if (ws) rewardPeer(ws, "tx-ok", "accepted-tx");
  rememberRecentTx(tx.id);
  if (ws) markPeerKnowsTx(ws, tx.id);

  console.log(`🧾 accepted tx ${shortHash(tx.id)} from=${ws ? peerLabel(ws) : "local"} mempool=${chain().mempool.size}`);
  announceTxIds([tx.id], ws);
  return true;
}

function handleTxBatch(ws: WebSocket, raws: any[]) {
  if (!Array.isArray(raws)) {
    markBad(ws, "bad-tx-batch");
    return;
  }

  networkStats.txBatchReceived++;
  const peer = peerLabel(ws);
  const acceptedIds: string[] = [];
  let got = 0;

  console.log(`📦 tx batch recv ${peer} | rawCount=${raws.length}`);

  for (const raw of raws.slice(0, MAX_TX_BATCH_TXS)) {
    try {
      const tx = Tx.fromJSON(raw);
      got++;
      markPeerKnowsTx(ws, tx.id);
      console.log(`📦 tx batch item ${peer} | tx=${shortHash(tx.id)}`);
      if (handleTxAccept(ws, tx)) acceptedIds.push(tx.id);
    } catch {
      markBad(ws, "bad-tx-batch");
      return;
    }
  }

  console.log(`📦 tx batch done ${peer} | got=${got} | accepted=${acceptedIds.length}`);
  rewardPeer(ws, "mempool-ok", "tx-batch-clean");
}

function pruneRecentBlockSeen() {
  const cutoff = now() - RECENT_BLOCK_TTL_MS;
  for (const [hash, seenAt] of recentBlockSeen.entries()) {
    if (seenAt < cutoff) recentBlockSeen.delete(hash);
  }
  while (recentBlockSeen.size > RECENT_BLOCK_CACHE_MAX) {
    const first = recentBlockSeen.keys().next();
    if (first.done) break;
    recentBlockSeen.delete(first.value);
  }
}

function rememberRecentBlock(hash: string) {
  if (!hash) return;
  recentBlockSeen.set(hash, now());
  pruneRecentBlockSeen();
}

function hasRecentBlock(hash: string) {
  pruneRecentBlockSeen();
  const seenAt = recentBlockSeen.get(hash);
  if (!seenAt) return false;
  if (seenAt < now() - RECENT_BLOCK_TTL_MS) {
    recentBlockSeen.delete(hash);
    return false;
  }
  return true;
}

function getPeerKnownBlockSet(ws: WebSocket) {
  let m = peerKnownBlocks.get(ws);
  if (!m) {
    m = new Map<string, number>();
    peerKnownBlocks.set(ws, m);
  }
  return m;
}

function prunePeerKnownBlocks(ws: WebSocket) {
  const m = getPeerKnownBlockSet(ws);
  const cutoff = now() - RECENT_BLOCK_TTL_MS;
  for (const [hash, seenAt] of m.entries()) {
    if (seenAt < cutoff) m.delete(hash);
  }
  while (m.size > PEER_KNOWN_BLOCK_MAX) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
}

function markPeerKnowsBlock(ws: WebSocket, hash: string) {
  if (!hash) return;
  const m = getPeerKnownBlockSet(ws);
  m.set(hash, now());
  prunePeerKnownBlocks(ws);
}

function peerKnowsBlock(ws: WebSocket, hash: string) {
  prunePeerKnownBlocks(ws);
  return getPeerKnownBlockSet(ws).has(hash);
}

function touchPendingCompact(hash: string, pb: PendingCompactBlock) {
  pendingCompactBlocks.delete(hash);
  pendingCompactBlocks.set(hash, pb);
  while (pendingCompactBlocks.size > PENDING_COMPACT_MAX) {
    const first = pendingCompactBlocks.keys().next();
    if (first.done) break;
    pendingCompactBlocks.delete(first.value);
  }
}

function collectMissingCompactTxIds(pb: PendingCompactBlock): string[] {
  const missing: string[] = [];
  let mempoolHits = 0;

  for (const txId of pb.compact.txIds) {
    if (pb.fetchedTxs.has(txId)) continue;
    if (chain().mempool.has(txId)) {
      mempoolHits++;
      continue;
    }
    missing.push(txId);
    if (missing.length >= MAX_BLOCK_TX_FETCH) break;
  }

  if (mempoolHits > pb.mempoolHits) {
    networkStats.compactRecoveredFromMempool += mempoolHits - pb.mempoolHits;
    pb.mempoolHits = mempoolHits;
  }

  pb.missingLast = missing.slice();
  return missing;
}

function tryAssembleCompactBlock(pb: PendingCompactBlock): { ready: boolean; block?: Block; missing?: string[] } {
  const compact = pb.compact;
  const coinbase = Tx.fromJSON(compact.coinbase);
  const txs: Tx[] = [coinbase];

  for (const txId of compact.txIds) {
    const fetched = pb.fetchedTxs.get(txId);
    if (fetched) {
      txs.push(fetched);
      continue;
    }

    const memTx = chain().mempool.get(txId);
    if (memTx) {
      txs.push(memTx);
      continue;
    }

    const missing = collectMissingCompactTxIds(pb);
    return { ready: false, missing };
  }

  const block = new Block({
    prevHash: compact.prevHash,
    ts: compact.ts,
    nonce: compact.nonce,
    difficulty: compact.difficulty,
    stateRoot: compact.stateRoot,
    txs,
    hash: compact.hash,
  });

  return { ready: true, block };
}

function requestMissingCompactTxs(ws: WebSocket, pb: PendingCompactBlock, missingRaw: string[], reason: string): boolean {
  const peer = peerLabel(ws);
  const nowMs = now();
  const missing = Array.from(
    new Set(
      missingRaw
        .filter((x) => typeof x === "string" && !!x)
        .filter((txId) => !pb.fetchedTxs.has(txId))
        .filter((txId) => !chain().mempool.has(txId))
        .slice(0, MAX_BLOCK_TX_FETCH)
    )
  );

  if (!missing.length) return false;

  const freshMissing = missing.filter((txId) => !pb.requestedTxIds.has(txId));
  const retryAllowed = nowMs - pb.lastRequestAt >= COMPACT_RECOVERY_MIN_RETRY_MS;
  const requestIds = freshMissing.length > 0 || retryAllowed ? (freshMissing.length ? freshMissing : missing) : [];

  if (!requestIds.length) {
    console.log(
      `⏳ compact recovery wait ${peer} | hash=${shortHash(pb.compact.hash)} | missing=${missing.length} | reason=${reason}`
    );
    return true;
  }

  if (pb.requestRounds >= COMPACT_RECOVERY_MAX_ROUNDS) {
    networkStats.compactFullFallbacks++;
    console.log(
      `↘️ compact recovery fallback full-block ${peer} | hash=${shortHash(pb.compact.hash)} | rounds=${pb.requestRounds} | missing=${missing.length} | reason=${reason}`
    );
    send(ws, { type: "BLOCK_FULL_GET", hash: pb.compact.hash });
    pb.lastRequestAt = nowMs;
    touchPendingCompact(pb.compact.hash, pb);
    return true;
  }

  for (const txId of requestIds) pb.requestedTxIds.add(txId);
  pb.requestRounds++;
  pb.lastRequestAt = nowMs;
  pb.missingLast = missing.slice();

  networkStats.compactTxRequestsSent++;
  networkStats.compactTxsRequested += requestIds.length;

  console.log(
    `📥 compact recovery tx get ${peer} | hash=${shortHash(pb.compact.hash)} | round=${pb.requestRounds}/${COMPACT_RECOVERY_MAX_ROUNDS} | request=${requestIds.length} | missing=${missing.length} | reason=${reason}`
  );
  send(ws, { type: "BLOCK_TX_GET", hash: pb.compact.hash, txIds: requestIds });
  touchPendingCompact(pb.compact.hash, pb);
  return true;
}

function announceBlock(hash: string, height: number, except?: WebSocket) {
  if (!hash) return;
  rememberRecentBlock(hash);

  let announcedPeers = 0;
  for (const ws of sockets) {
    if (except && ws === except) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (peerKnowsBlock(ws, hash)) continue;

    markPeerKnowsBlock(ws, hash);
    send(ws, { type: "BLOCK_INV", hash, height });
    announcedPeers++;
    console.log(`🧱 block inv sent ${peerLabel(ws)} | height=${height} | hash=${shortHash(hash)}`);
  }

  console.log(`🧱 block inv summary | peers=${announcedPeers} | height=${height} | hash=${shortHash(hash)}`);
}

function handleBlockInv(ws: WebSocket, hash: string, height: number) {
  const peer = peerLabel(ws);
  if (typeof hash !== "string" || !hash) {
    markBad(ws, "bad-block-inv");
    return;
  }

  peerRemoteHeight.set(ws, height);
  markPeerKnowsBlock(ws, hash);
  console.log(`🧱 block inv recv ${peer} | height=${height} | hash=${shortHash(hash)}`);

  if (hasBlock(hash)) {
    console.log(`⏭️ block inv already-have ${peer} | hash=${shortHash(hash)}`);
    return;
  }
  if (hasRecentBlock(hash)) {
    console.log(`⏭️ block inv recent-seen ${peer} | hash=${shortHash(hash)}`);
    return;
  }

  rememberRecentBlock(hash);
  send(ws, { type: "BLOCK_GET", hash });
  console.log(`📥 block get sent ${peer} | hash=${shortHash(hash)}`);
}

function handleBlockGet(ws: WebSocket, hash: string) {
  const peer = peerLabel(ws);
  if (typeof hash !== "string" || !hash) {
    markBad(ws, "bad-block-get");
    return;
  }

  console.log(`📥 block get recv ${peer} | hash=${shortHash(hash)}`);
  const blk = blockByHash(hash);
  if (!blk) {
    console.log(`⚠️ block get miss ${peer} | hash=${shortHash(hash)}`);
    return;
  }

  const height = heightOfHash(hash);
  const compact = compactFromBlock(blk, height);
  markPeerKnowsBlock(ws, hash);
  send(ws, { type: "COMPACT_BLOCK", block: compact });
  console.log(
    `📦 compact block sent ${peer} | height=${height} | hash=${shortHash(hash)} | coinbase=1 | shortTxs=${compact.txIds.length}`
  );
}

function handleBlockFullGet(ws: WebSocket, hash: string) {
  const peer = peerLabel(ws);
  if (typeof hash !== "string" || !hash) {
    markBad(ws, "bad-block-full-get");
    return;
  }

  console.log(`📥 full block get recv ${peer} | hash=${shortHash(hash)}`);
  const blk = blockByHash(hash);
  if (!blk) {
    console.log(`⚠️ full block get miss ${peer} | hash=${shortHash(hash)}`);
    return;
  }

  markPeerKnowsBlock(ws, hash);
  send(ws, { type: "BLOCK", block: blk.toJSON() });
  console.log(`📦 full block sent ${peer} | hash=${shortHash(hash)} | txs=${blk.txs.length}`);
}

function handleCompactBlock(ws: WebSocket, compact: CompactBlockJson) {
  const peer = peerLabel(ws);
  if (!compact || typeof compact !== "object") {
    markBad(ws, "bad-compact-block");
    return;
  }
  if (typeof compact.hash !== "string" || !compact.hash) {
    markBad(ws, "bad-compact-block");
    return;
  }

  networkStats.compactReceived++;
  peerRemoteHeight.set(ws, compact.height);
  peerRemoteTipHash.set(ws, compact.hash);

  rememberRecentBlock(compact.hash);
  markPeerKnowsBlock(ws, compact.hash);

  if (hasBlock(compact.hash)) {
    console.log(`⏭️ compact block already-have ${peer} | hash=${shortHash(compact.hash)}`);
    return;
  }

  const pb: PendingCompactBlock = {
    peer,
    compact,
    fetchedTxs: new Map<string, Tx>(),
    requestedTxIds: new Set<string>(),
    requestRounds: 0,
    createdAt: now(),
    lastRequestAt: 0,
    lastProgressAt: now(),
    mempoolHits: 0,
    recoveredTxs: 0,
    missingLast: [],
  };
  touchPendingCompact(compact.hash, pb);

  console.log(
    `📦 compact block recv ${peer} | height=${compact.height} | hash=${shortHash(compact.hash)} | shortTxs=${compact.txIds.length}`
  );

  const assembled = tryAssembleCompactBlock(pb);
  if (assembled.ready && assembled.block) {
    const orphansBefore = chain().orphanCount();
    const ok = chain().tryAddBlock(assembled.block);
    const orphansAfter = chain().orphanCount();
    applyOrphanDelta(orphansBefore, orphansAfter, ok);

    if (!ok) {
      networkStats.compactRejected++;
      console.log(`❌ compact block rejected ${peer} | hash=${shortHash(compact.hash)}`);
      pendingCompactBlocks.delete(compact.hash);
      return;
    }

    networkStats.compactAccepted++;
    rewardPeer(ws, "compact-block-ok", "accepted-compact-block");
    console.log(`🧱 accepted compact block ${shortHash(compact.hash)} height=${chain().height()}`);
    pendingCompactBlocks.delete(compact.hash);
    announceBlock(compact.hash, chain().height(), ws);
    maybeRequestMempool(ws, "accepted-compact-block");
    return;
  }

  const missing = assembled.missing ?? [];
  if (!missing.length) {
    networkStats.compactStalled++;
    console.log(`❌ compact block stalled ${peer} | hash=${shortHash(compact.hash)}`);
    pendingCompactBlocks.delete(compact.hash);
    return;
  }

  requestMissingCompactTxs(ws, pb, missing, "initial-missing");
}

function handleBlockTxGet(ws: WebSocket, hash: string, txIds: string[]) {
  const peer = peerLabel(ws);
  if (typeof hash !== "string" || !hash || !Array.isArray(txIds)) {
    markBad(ws, "bad-block-tx-get");
    return;
  }

  const blk = blockByHash(hash);
  if (!blk) {
    console.log(`⚠️ block tx get miss-block ${peer} | hash=${shortHash(hash)}`);
    return;
  }

  const want = Array.from(new Set(txIds.filter((x) => typeof x === "string" && !!x).slice(0, MAX_BLOCK_TX_FETCH)));

  console.log(`📥 block tx get recv ${peer} | hash=${shortHash(hash)} | wanted=${want.length}`);

  const byId = new Map<string, Tx>();
  for (const tx of blk.txs.slice(1)) byId.set(tx.id, tx);

  const out: any[] = [];
  for (const txId of want) {
    const tx = byId.get(txId);
    if (!tx) continue;
    out.push(tx.toJSON());
  }

  send(ws, { type: "BLOCK_TX_BATCH", hash, txs: out });
  console.log(`📦 block tx batch sent ${peer} | hash=${shortHash(hash)} | txs=${out.length}`);
}

function handleBlockTxBatch(ws: WebSocket, hash: string, raws: any[]) {
  const peer = peerLabel(ws);
  if (typeof hash !== "string" || !hash || !Array.isArray(raws)) {
    markBad(ws, "bad-block-tx-batch");
    return;
  }

  const pb = pendingCompactBlocks.get(hash);
  if (!pb) {
    console.log(`⚠️ block tx batch no-pending ${peer} | hash=${shortHash(hash)}`);
    return;
  }

  networkStats.compactTxBatchesReceived++;
  console.log(`📦 compact recovery tx batch recv ${peer} | hash=${shortHash(hash)} | txs=${raws.length}`);

  let recoveredNow = 0;
  for (const raw of raws.slice(0, MAX_BLOCK_TX_FETCH)) {
    try {
      const tx = Tx.fromJSON(raw);
      if (!pb.compact.txIds.includes(tx.id)) {
        console.log(`⚠️ compact recovery ignored unexpected tx ${peer} | hash=${shortHash(hash)} | tx=${shortHash(tx.id)}`);
        continue;
      }
      if (!pb.fetchedTxs.has(tx.id) && !chain().mempool.has(tx.id)) recoveredNow++;
      pb.fetchedTxs.set(tx.id, tx);
      markPeerKnowsTx(ws, tx.id);
    } catch {
      markBad(ws, "bad-block-tx-batch");
      return;
    }
  }

  if (recoveredNow > 0) {
    pb.recoveredTxs += recoveredNow;
    pb.lastProgressAt = now();
    networkStats.compactTxsRecovered += recoveredNow;
  }

  touchPendingCompact(hash, pb);

  const assembled = tryAssembleCompactBlock(pb);
  if (!assembled.ready || !assembled.block) {
    const missing = assembled.missing ?? [];
    if (!missing.length) {
      networkStats.compactStalled++;
      console.log(`❌ compact block unresolved ${peer} | hash=${shortHash(hash)} | recovered=${pb.recoveredTxs}`);
      pendingCompactBlocks.delete(hash);
      return;
    }

    const requested = requestMissingCompactTxs(ws, pb, missing, recoveredNow > 0 ? "partial-progress" : "still-missing");
    if (!requested) {
      networkStats.compactStalled++;
      console.log(`❌ compact block stalled ${peer} | hash=${shortHash(hash)} | missing=${missing.length}`);
      pendingCompactBlocks.delete(hash);
    }
    return;
  }

  const orphansBefore = chain().orphanCount();
  const ok = chain().tryAddBlock(assembled.block);
  const orphansAfter = chain().orphanCount();
  applyOrphanDelta(orphansBefore, orphansAfter, ok);

  if (!ok) {
    networkStats.compactRejected++;
    console.log(`❌ compact block rejected ${peer} | hash=${shortHash(hash)}`);
    pendingCompactBlocks.delete(hash);
    return;
  }

  networkStats.compactAccepted++;
  rewardPeer(ws, "compact-block-ok", "accepted-compact-block-tx-batch");
  console.log(
    `🧱 accepted recovered compact block ${shortHash(hash)} height=${chain().height()} recovered=${pb.recoveredTxs} mempoolHits=${pb.mempoolHits} rounds=${pb.requestRounds}`
  );
  pendingCompactBlocks.delete(hash);
  announceBlock(hash, chain().height(), ws);
  maybeRequestMempool(ws, "accepted-compact-block");
}

function handleFullBlock(ws: WebSocket, rawBlock: any) {
  const peer = peerLabel(ws);
  const b = Block.fromJSON(rawBlock);
  networkStats.fullBlockReceived++;
  peerRemoteTipHash.set(ws, b.hash);

  rememberRecentBlock(b.hash);
  markPeerKnowsBlock(ws, b.hash);

  const orphansBefore = chain().orphanCount();
  const ok = chain().tryAddBlock(b);
  const orphansAfter = chain().orphanCount();
  applyOrphanDelta(orphansBefore, orphansAfter, ok);

  if (!ok) {
    networkStats.fullBlockRejected++;
    pendingCompactBlocks.delete(b.hash);
    console.log(`❌ block full rejected ${peer} | hash=${shortHash(b.hash)} prev=${shortHash(b.prevHash)}`);
    return;
  }

  pendingCompactBlocks.delete(b.hash);
  networkStats.fullBlockAccepted++;
  rewardPeer(ws, "block-ok", "accepted-full-block");
  console.log(`🧱 accepted block ${shortHash(b.hash)} height=${chain().height()}`);
  announceBlock(b.hash, chain().height(), ws);
  maybeRequestMempool(ws, "accepted-block");
}


function clampIbdChunkSize(n: number): number {
  const safe = Math.floor(Number.isFinite(n) ? n : REQUEST_CHUNK_SIZE);
  return Math.max(IBD_MIN_CHUNK_SIZE, Math.min(IBD_MAX_CHUNK_SIZE, safe));
}

function preferredIbdChunkSize(ws: WebSocket, remaining: number): number {
  const current = peerSyncChunkSize.get(ws) ?? REQUEST_CHUNK_SIZE;

  if (remaining >= IBD_FAST_LAG_BLOCKS) {
    return clampIbdChunkSize(Math.max(current, IBD_MAX_CHUNK_SIZE));
  }

  if (remaining >= IBD_MEDIUM_LAG_BLOCKS) {
    return clampIbdChunkSize(Math.max(current, 64));
  }

  if (remaining <= REQUEST_CHUNK_SIZE) {
    return clampIbdChunkSize(Math.min(current, REQUEST_CHUNK_SIZE));
  }

  return clampIbdChunkSize(current);
}

function requestBlockRangeOptimized(ws: WebSocket, fromHeight: number, remaining: number, reason: string) {
  const peer = peerLabel(ws);
  const desired = preferredIbdChunkSize(ws, remaining);
  const want = Math.max(1, Math.min(desired, Math.max(1, remaining)));

  peerSyncChunkSize.set(ws, desired);
  peerSyncRequestStartedAt.set(ws, now());

  networkStats.initialBlockDownloadRequests++;
  if (want > REQUEST_CHUNK_SIZE) networkStats.initialBlockDownloadFastChunks++;

  console.log(
    `📦 ibd request out:${peer} | from=${fromHeight} | count=${want} | remaining=${remaining} | chunk=${desired} | reason=${reason}`
  );

  send(ws, { type: "BLOCK_RANGE_REQUEST", fromHeight, maxCount: want });
}

function adjustIbdChunkSizeAfterResponse(ws: WebSocket, got: number, remainingAfter: number) {
  const current = peerSyncChunkSize.get(ws) ?? REQUEST_CHUNK_SIZE;
  const startedAt = peerSyncRequestStartedAt.get(ws) ?? 0;
  const elapsedMs = startedAt > 0 ? now() - startedAt : 0;

  networkStats.initialBlockDownloadLastChunkMs = elapsedMs;
  networkStats.initialBlockDownloadBlocks += Math.max(0, got);

  if (remainingAfter <= 0) return;

  if (elapsedMs > 0 && elapsedMs <= IBD_FAST_RESPONSE_MS && got >= current && current < IBD_MAX_CHUNK_SIZE) {
    const next = clampIbdChunkSize(current * 2);
    if (next !== current) {
      peerSyncChunkSize.set(ws, next);
      networkStats.initialBlockDownloadAdaptiveUpshifts++;
      console.log(`🚀 ibd chunk upshift ${peerLabel(ws)} | ${current}->${next} | elapsedMs=${elapsedMs} | remaining=${remainingAfter}`);
    }
    return;
  }

  if ((elapsedMs >= IBD_SLOW_RESPONSE_MS || got < Math.max(1, Math.floor(current / 2))) && current > IBD_MIN_CHUNK_SIZE) {
    const next = clampIbdChunkSize(Math.max(IBD_MIN_CHUNK_SIZE, Math.floor(current / 2)));
    if (next !== current) {
      peerSyncChunkSize.set(ws, next);
      networkStats.initialBlockDownloadAdaptiveDownshifts++;
      console.log(`🐢 ibd chunk downshift ${peerLabel(ws)} | ${current}->${next} | elapsedMs=${elapsedMs} | got=${got}`);
    }
  }
}

function handleHeadersResponse(ws: WebSocket, headers: BlockHeader[]) {
  const peer = peerLabel(ws);

  if (!Array.isArray(headers) || !validateHeaderCommitments(headers)) {
    console.log(`❌ bad headers from ${peer}`);
    markBad(ws, "bad-headers");
    return;
  }

  networkStats.headersResponsesSeen++;
  rewardPeer(ws, "headers-ok", "valid-headers");
  const localHeaders = chain().exportHeaders();
  const localBlocks = localHeaders.length;
  const remoteBlocks = headers.length;
  const common = commonHeaderHeight(localHeaders, headers);

  networkStats.lastHeadersCommonHeight = common;
  networkStats.lastHeadersRemoteHeight = remoteBlocks - 1;

  if (headers.length > 0) {
    peerRemoteHeight.set(ws, headers.length - 1);
    peerRemoteTipHash.set(ws, headers[headers.length - 1].hash);
  }

  console.log(`👀 headers seen out:${peer} | localBlocks=${localBlocks} | remoteBlocks=${remoteBlocks}`);

  if (remoteBlocks <= localBlocks) {
    console.log(`🟰 sync noop out:${peer} | localBlocks=${localBlocks} | remoteBlocks=${remoteBlocks}`);
    if (isSyncOwner(ws) && !localNeedsSync()) {
      releaseSyncOwner("caught-up-noop");
    }
    return;
  }

  if (!acquireSyncOwner(ws, "headers-response")) {
    return;
  }

  if (shouldTrySnapshotBootstrap(remoteBlocks - 1)) {
    maybeStartSnapshotBootstrap(ws, remoteBlocks - 1, "headers-seen");
    return;
  }

  const from = common + 1;
  const remaining = remoteBlocks - from;

  console.log(
    `🔄 sync start out:${peer} | localHeight=${localBlocks - 1} | remoteHeight=${remoteBlocks - 1} | common=${common}`
  );

  requestBlockRangeOptimized(ws, from, remaining, "headers-response");
}

function handleBlockRangeResponse(ws: WebSocket, fromHeight: number, blocks: any[]) {
  const peer = peerLabel(ws);
  if (!Array.isArray(blocks) || !blocks.length) return;

  if (!isSyncOwner(ws)) {
    console.log(`⏭️ ignored block range from non-owner ${peer} | owner=${activeSyncPeer ?? "(none)"} | from=${fromHeight}`);
    return;
  }

  networkStats.blockRangeResponsesSeen++;
  const got = blocks.length;
  console.log(`📬 chunk response out:${peer} | from=${fromHeight} | got=${got}`);

  const orphansBefore = chain().orphanCount();
  const ok = chain().applyBlockRange(fromHeight, blocks);
  const orphansAfter = chain().orphanCount();
  applyOrphanDelta(orphansBefore, orphansAfter, ok);

  if (!ok) {
    console.log(`❌ block range apply failed from out:${peer} at fromHeight=${fromHeight}`);
    releaseSyncOwner("range-apply-failed");
    return;
  }

  for (const raw of blocks) {
    try {
      const b = Block.fromJSON(raw);
      rememberRecentBlock(b.hash);
      markPeerKnowsBlock(ws, b.hash);
      peerRemoteTipHash.set(ws, b.hash);
    } catch {}
  }

  networkStats.lastChunkFromHeight = fromHeight;
  networkStats.lastChunkSize = got;
  networkStats.lastChunkAppliedHeight = fromHeight + got - 1;
  networkStats.lastChunkAt = Date.now();
  peerRemoteHeight.set(ws, Math.max(peerRemoteHeight.get(ws) ?? 0, fromHeight + got - 1));

  const lastApplied = fromHeight + got - 1;
  const localHeight = chain().height();
  const progress = `${lastApplied}/${Math.max(lastApplied, localHeight)}`;

  console.log(`✅ sync chunk out:${peer} | chunk#=1 | applied=${fromHeight}-${lastApplied} | progress=${progress}`);

  const remoteHeight = peerRemoteHeight.get(ws) ?? localHeight;
  const remainingAfter = Math.max(0, remoteHeight - localHeight);
  adjustIbdChunkSizeAfterResponse(ws, got, remainingAfter);

  if (localHeight >= remoteHeight) {
    console.log(`✅ sync complete with ${peer} | localHeight=${localHeight} | remoteHeight=${remoteHeight}`);
    releaseSyncOwner("caught-up");
    maybeRequestMempool(ws, "chunk-complete");
    send(ws, { type: "HEADERS_REQUEST" });
    return;
  }

  networkStats.initialBlockDownloadRetryHeaders++;
  send(ws, { type: "HEADERS_REQUEST" });
}

function onSocketOpen(ws: WebSocket, peerUrl?: string) {
  if (peerUrl && isSelfPeerUrl(peerUrl)) {
    console.log(`↪️ self-dial prevented ${peerUrl}`);
    try {
      ws.close(1000, "self-peer");
    } catch {}
    return;
  }

  sockets.add(ws);
  socketOpenedAt.set(ws, Date.now());
  socketDirection.set(ws, peerUrl ? "outbound" : "inbound");
  lastSeenAt.set(ws, now());
  getPeerKnownSet(ws);
  getPeerKnownBlockSet(ws);

  if (peerUrl) {
    const n = normalizeWsUrl(peerUrl);
    if (n && !isSelfPeerUrl(n)) {
      peerBySocket.set(ws, n);
      outboundUrls.add(n);
      rememberPeer(n);
      clearReconnect(n);
      console.log(`✅ Connected to peer ${n}`);
    }
  }

  peerReputation.record(reputationPeerId(ws), "connect", peerUrl ? "outbound-open" : "inbound-open");

  send(ws, { type: "HEADERS_REQUEST" });
  send(ws, { type: "PEERS_REQUEST" });
  maybeRequestMempool(ws, peerUrl ? "outbound-open" : "inbound-connect");
  requestSnapshotMeta(ws, peerUrl ? "outbound-open" : "inbound-connect");
}

function onSocketClose(ws: WebSocket, code?: number, reason?: Buffer, attempts = 0) {
  sockets.delete(ws);
  lastSeenAt.delete(ws);
  socketOpenedAt.delete(ws);
  socketDirection.delete(ws);
  peerLastPingSentAt.delete(ws);
  peerLatencyMs.delete(ws);
  peerRemoteHeight.delete(ws);
  peerRemoteTipHash.delete(ws);
  peerSyncChunkSize.delete(ws);
  peerSyncRequestStartedAt.delete(ws);
  peerKnownTxs.delete(ws);
  peerKnownBlocks.delete(ws);

  const peer = peerBySocket.get(ws);
  peerReputation.record(peer || getRemoteIp(ws), "disconnect", reason?.toString("utf8") || `code=${code ?? 0}`);
  if (peer && snapshotBootstrap.peer === peer) {
    resetSnapshotBootstrap("peer-closed");
  }
  if (peer && activeSyncPeer === peer) {
    releaseSyncOwner("peer-closed");
  }

  const ip = getRemoteIp(ws);
  const inbound = inboundByIp.get(ip) ?? 0;
  if (inbound > 0) inboundByIp.set(ip, Math.max(0, inbound - 1));

  if (peer) {
    peerBySocket.delete(ws);
    outboundUrls.delete(peer);
    console.log(`👋 outbound closed ${peer}: code=${code ?? ""} reason=${reason?.toString() ?? ""}`);
    if (!isSelfPeerUrl(peer)) {
      scheduleReconnect(peer, attempts + 1);
    }
  } else {
    console.log(
      `👋 inbound closed ${ip}:${(ws as any)?._socket?.remotePort ?? ""} code=${code ?? ""} reason=${
        reason?.toString() ?? ""
      }`
    );
  }
}

function safeParseMessage(data: any): Envelope | null {
  try {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const packedBytes = Buffer.byteLength(text, "utf8");
    if (packedBytes > MAX_MSG_BYTES) return null;

    const parsed = JSON.parse(text);
    if (isCompressedEnvelope(parsed)) {
      const gz = Buffer.from(parsed.payloadBase64, "base64");
      const inflated = zlib.gunzipSync(gz).toString("utf8");
      const rawBytes = Buffer.byteLength(inflated, "utf8");
      if (rawBytes > MAX_MSG_BYTES * 8) return null;

      const inner = JSON.parse(inflated);
      if (!validateEnvelopeShape(inner)) return null;
      console.log(`🗜️ decompressed ${parsed.innerType} | packed=${packedBytes} | raw=${rawBytes}`);
      networkStats.messagesReceived++;
      networkStats.compressedMessagesReceived++;
      networkStats.bytesReceivedApprox += packedBytes;
      return inner;
    }

    if (!validateEnvelopeShape(parsed)) return null;
    networkStats.messagesReceived++;
    networkStats.bytesReceivedApprox += packedBytes;
    return parsed;
  } catch {
    return null;
  }
}

function handleMessage(ws: WebSocket, msg: Envelope) {
  lastSeenAt.set(ws, now());
  if (!allowByRate(ws)) return;

  const peer = peerLabel(ws);

  if (msg.type === "PING") {
    send(ws, { type: "PONG" });
    return;
  }

  if (msg.type === "PONG") {
    const sentAt = peerLastPingSentAt.get(ws);
    if (sentAt) {
      peerLatencyMs.set(ws, Math.max(0, Date.now() - sentAt));
    }
    return;
  }

  if (msg.type === "HEADERS_REQUEST") {
    send(ws, { type: "HEADERS_RESPONSE", headers: chain().exportHeaders() });
    return;
  }

  if (msg.type === "HEADERS_RESPONSE") {
    handleHeadersResponse(ws, msg.headers);
    return;
  }

  if (msg.type === "BLOCK_RANGE_REQUEST") {
    const from = Math.max(0, msg.fromHeight | 0);
    const maxCount = Math.max(1, Math.min(IBD_MAX_CHUNK_SIZE, msg.maxCount | 0));
    const blocks = chain().exportBlockRange(from, maxCount);
    console.log(`📤 block range | from=${from} | count=${blocks.length}`);
    send(ws, { type: "BLOCK_RANGE_RESPONSE", fromHeight: from, blocks });
    return;
  }

  if (msg.type === "BLOCK_RANGE_RESPONSE") {
    handleBlockRangeResponse(ws, msg.fromHeight, msg.blocks);
    return;
  }

  if (msg.type === "BLOCK_INV") {
    handleBlockInv(ws, msg.hash, msg.height);
    return;
  }

  if (msg.type === "BLOCK_GET") {
    handleBlockGet(ws, msg.hash);
    return;
  }

  if (msg.type === "BLOCK_FULL_GET") {
    handleBlockFullGet(ws, msg.hash);
    return;
  }

  if (msg.type === "COMPACT_BLOCK") {
    handleCompactBlock(ws, msg.block);
    return;
  }

  if (msg.type === "BLOCK_TX_GET") {
    handleBlockTxGet(ws, msg.hash, msg.txIds);
    return;
  }

  if (msg.type === "BLOCK_TX_BATCH") {
    handleBlockTxBatch(ws, msg.hash, msg.txs);
    return;
  }

  if (msg.type === "BLOCK") {
    handleFullBlock(ws, msg.block);
    return;
  }

  if (msg.type === "TX") {
    try {
      const tx = Tx.fromJSON(msg.tx);
      markPeerKnowsTx(ws, tx.id);
      console.log(`📨 tx direct recv ${peer} | tx=${shortHash(tx.id)}`);
      handleTxAccept(ws, tx);
    } catch {
      markBad(ws, "bad-tx");
    }
    return;
  }

  if (msg.type === "TX_INV") {
    networkStats.txInvReceived++;
    if (!Array.isArray(msg.txIds)) {
      markBad(ws, "bad-tx-inv");
      return;
    }

    const txIds = Array.from(new Set(msg.txIds.filter((x) => typeof x === "string" && !!x).slice(0, MAX_TX_INV_IDS)));

    markPeerKnowsTxs(ws, txIds);
    console.log(`📣 tx inv recv ${peer} | count=${txIds.length} | ids=${txIds.map(shortHash).join(",")}`);

    const missing = collectMissingTxIds(txIds);
    console.log(`🔎 tx inv inspect ${peer} | missing=${missing.length} | mempool=${chain().mempool.size}`);

    if (missing.length) {
      console.log(`📥 tx get sent ${peer} | count=${missing.length} | ids=${missing.map(shortHash).join(",")}`);
      send(ws, { type: "TX_GET", txIds: missing });
    }
    return;
  }

  if (msg.type === "TX_GET") {
    if (!Array.isArray(msg.txIds)) {
      markBad(ws, "bad-tx-get");
      return;
    }

    const wantIds = Array.from(new Set(msg.txIds.filter((x) => typeof x === "string" && !!x).slice(0, MAX_TX_GET_IDS)));

    console.log(`📥 tx get recv ${peer} | count=${wantIds.length} | ids=${wantIds.map(shortHash).join(",")}`);

    const txs: any[] = [];
    for (const txId of wantIds) {
      const tx = chain().mempool.get(txId);
      if (!tx) {
        console.log(`⚠️ tx get miss ${peer} | tx=${shortHash(txId)}`);
        continue;
      }
      markPeerKnowsTx(ws, txId);
      txs.push(tx.toJSON());
      console.log(`📦 tx batch queue ${peer} | tx=${shortHash(txId)}`);
      if (txs.length >= MAX_TX_BATCH_TXS) break;
    }

    if (txs.length) {
      console.log(`📦 tx batch sent ${peer} | requested=${wantIds.length} | sending=${txs.length}`);
      send(ws, { type: "TX_BATCH", txs });
    } else {
      console.log(`⚠️ tx batch none ${peer} | requested=${wantIds.length}`);
    }
    return;
  }

  if (msg.type === "TX_BATCH") {
    handleTxBatch(ws, msg.txs);
    return;
  }

  if (msg.type === "SNAPSHOT_META_REQUEST") {
    handleSnapshotMetaRequest(ws, msg.reqId);
    return;
  }

  if (msg.type === "SNAPSHOT_META_RESPONSE") {
    handleSnapshotMetaResponse(ws, msg);
    return;
  }

  if (msg.type === "SNAPSHOT_REQUEST") {
    handleSnapshotRequest(ws, msg.reqId);
    return;
  }

  if (msg.type === "SNAPSHOT_RESPONSE") {
    handleSnapshotResponse(ws, msg);
    return;
  }

  if (msg.type === "PROOF_REQUEST") {
    if (msg.kind !== "balance" && msg.kind !== "nonce" && msg.kind !== "pending" && msg.kind !== "minted") {
      markBad(ws, "bad-proof-kind");
      return;
    }
    handleProofRequest(ws, msg.kind, msg.reqId, msg.address, msg.pendingIndex);
    return;
  }

  if (msg.type === "PROOF_RESPONSE") {
    handleProofResponse(ws, msg);
    return;
  }

  if (msg.type === "PEERS_REQUEST") {
    const peers = Array.from(peerTable).filter((p) => !isSelfPeerUrl(p));
    if (advertisedPeerUrl && !isSelfPeerUrl(advertisedPeerUrl)) peers.unshift(advertisedPeerUrl);
    send(ws, { type: "PEERS_RESPONSE", peers: peers.slice(0, PEER_TABLE_MAX) });
    return;
  }

  if (msg.type === "PEERS_RESPONSE") {
    let learned = 0;
    let skippedSelf = 0;
    for (const raw of msg.peers || []) {
      const p = normalizeWsUrl(raw);
      if (!p) continue;
      if (isSelfPeerUrl(p)) {
        skippedSelf++;
        continue;
      }
      if (!peerTable.has(p)) learned++;
      rememberPeer(p);
    }
    console.log(`🧭 learned ${learned} peer(s) | skippedSelf=${skippedSelf} | known=${peerTable.size}`);
    return;
  }

  if (msg.type === "MEMPOOL_REQUEST") {
    const txs = Array.from(chain().mempool.values())
      .slice(0, MAX_TX_BATCH_TXS)
      .map((t) => t.toJSON());
    console.log(`🧰 mempool response prep ${peer} | txs=${txs.length}`);
    send(ws, { type: "MEMPOOL_RESPONSE", txs });
    return;
  }

  if (msg.type === "MEMPOOL_RESPONSE") {
    networkStats.mempoolResponsesReceived++;
    let got = 0;
    let added = 0;
    const acceptedIds: string[] = [];

    for (const raw of msg.txs || []) {
      try {
        const tx = Tx.fromJSON(raw);
        got++;
        markPeerKnowsTx(ws, tx.id);
        if (handleTxAccept(ws, tx)) {
          added++;
          acceptedIds.push(tx.id);
        }
      } catch {
        markBad(ws, "bad-mempool-response");
        return;
      }
    }

    console.log(`🧰 mempool response ${peer} | got=${got} | added=${added}`);
    rewardPeer(ws, "mempool-ok", "mempool-response-clean");

    if (acceptedIds.length) {
      announceTxIds(acceptedIds, ws);
    }
    return;
  }
}

function wireSocket(ws: WebSocket, peerUrl?: string, attempts = 0) {
  ws.on("open", () => onSocketOpen(ws, peerUrl));

  ws.on("message", (data) => {
    const rawBytes =
      typeof data === "string"
        ? Buffer.byteLength(data, "utf8")
        : Buffer.isBuffer(data)
        ? data.length
        : Buffer.byteLength(data.toString(), "utf8");

    const throttle = bandwidthThrottle.allowInbound(peerLabel(ws), rawBytes);
    if (!throttle.allowed) {
      networkStats.bandwidthInboundRejected++;
      networkStats.bandwidthBytesDroppedApprox += rawBytes;
      console.log(
        `🚦 inbound bandwidth throttle peer=${peerLabel(ws)} bytes=${rawBytes} reason=${throttle.reason}`
      );
      markBad(ws, "bandwidth-throttle");
      return;
    }

    networkStats.bandwidthInboundAllowed++;

    const msg = safeParseMessage(data);
    if (!msg) {
      networkStats.badMessages++;
      markBad(ws, "bad-message");
      return;
    }
    rewardPeer(ws, "message-ok", "parsed-message");
    handleMessage(ws, msg);
  });

  ws.on("close", (code, reason) => onSocketClose(ws, code, reason, attempts));

  ws.on("error", (err: any) => {
    const peer = peerUrl || getRemoteIp(ws);
    if (peerUrl && peerUrl.startsWith("wss://")) networkStats.tlsClientErrors++;
    if (peerUrl) {
      const seedUrls = new Set(getPublicSeedStats().seeds.map((x) => x.url));
      if (seedUrls.has(peerUrl)) networkStats.publicSeedDialErrors++;
    }
    peerReputation.punish(peer, "socket-error", err?.message || String(err));
    console.log(`❌ connectToPeer error ${peer}: ${err?.message || err}`);
  });
}

export function connectToPeer(url: string, onReady?: (ws: WebSocket) => void, attempts = 0): WebSocket | null {
  const n = normalizeWsUrl(url);
  if (!n) return null;
  if (isSelfPeerUrl(n)) {
    console.log(`↪️ self-dial skip ${n}`);
    peerTable.delete(n);
    knownPeers.delete(n);
    clearReconnect(n);
    savePeerTable();
    return null;
  }

  networkStats.reconnectAttempts++;

  const seedUrls = new Set(getPublicSeedStats().seeds.map((x) => x.url));
  if (seedUrls.has(n)) networkStats.publicSeedDials++;
  knownPeers.add(n);
  rememberPeer(n);

  if (outboundUrls.has(n)) return null;

  console.log(`📞 dialing peer ${n} | attempt=${attempts}`);

  try {
    const isTlsDial = n.startsWith("wss://");
    if (isTlsDial) networkStats.tlsClientDials++;
    const ws = new WebSocket(n, {
      handshakeTimeout: 7500,
      maxPayload: MAX_MSG_BYTES,
      ...buildP2PTlsClientOptions(p2pTlsConfig),
    });
    wireSocket(ws, n, attempts);
    ws.once("open", () => {
      if (onReady) onReady(ws);
    });
    return ws;
  } catch (e: any) {
    if (n.startsWith("wss://")) networkStats.tlsClientErrors++;
    const seedUrls = new Set(getPublicSeedStats().seeds.map((x) => x.url));
    if (seedUrls.has(n)) networkStats.publicSeedDialErrors++;
    console.log(`❌ connectToPeer error ${n}: ${e?.message || e}`);
    scheduleReconnect(n, attempts + 1);
    return null;
  }
}

function maybeDiscoveryDial() {
  if (activeSyncPeer) {
    console.log(`⏸️ discovery skipped | syncOwner=${activeSyncPeer}`);
    return;
  }

  for (const peer of peerTable) {
    if (isSelfPeerUrl(peer)) continue;
    if (outboundUrls.has(peer)) continue;
    networkStats.discoveryDials++;
    connectToPeer(peer);
    break;
  }
}

function runDiscoveryLoop() {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = setInterval(() => {
    console.log(`🧭 discovery dial`);
    maybeDiscoveryDial();
  }, DISCOVERY_MS);
}

function runHeartbeatLoop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const t = now();
    pruneRecentTxSeen();
    pruneRecentBlockSeen();

    for (const ws of sockets) {
      const seen = lastSeenAt.get(ws) ?? t;
      if (t - seen > STALE_SOCKET_MS) {
        networkStats.staleSocketsClosed++;
        try {
          ws.close(1000, "stale");
        } catch {}
        continue;
      }

      prunePeerKnownSet(ws);
      prunePeerKnownBlocks(ws);
      peerLastPingSentAt.set(ws, t);
      networkStats.heartbeatPingsSent++;
      send(ws, { type: "PING" });
    }
  }, HEARTBEAT_MS);
}

export function getNetworkPeerStats(): NetworkPeerStats[] {
  const t = Date.now();
  const out: NetworkPeerStats[] = [];

  for (const ws of sockets) {
    const connectedAt = socketOpenedAt.get(ws) ?? null;
    const lastSeen = lastSeenAt.get(ws) ?? null;
    const url = peerBySocket.get(ws) ?? null;
    const ip = getRemoteIp(ws);
    const direction = socketDirection.get(ws) ?? "unknown";
    const remoteHeight = peerRemoteHeight.get(ws) ?? null;
    const remoteTipHash = peerRemoteTipHash.get(ws) ?? null;

    out.push({
      peer: peerLabel(ws),
      url,
      ip,
      direction,
      readyState: ws.readyState,
      readyStateLabel: readyStateLabel(ws),
      connectedAt,
      connectedForMs: connectedAt === null ? null : Math.max(0, t - connectedAt),
      lastSeenAt: lastSeen,
      idleMs: lastSeen === null ? null : Math.max(0, t - lastSeen),
      lastPingSentAt: peerLastPingSentAt.get(ws) ?? null,
      latencyMs: peerLatencyMs.get(ws) ?? null,
      remoteHeight,
      remoteTipHash,
      reputation: peerReputation.snapshot(peerLabel(ws)),
      bandwidth: bandwidthThrottle.snapshot(peerLabel(ws)),
    });
  }

  out.sort((a, b) => {
    const dirA = a.direction === "outbound" ? 0 : a.direction === "inbound" ? 1 : 2;
    const dirB = b.direction === "outbound" ? 0 : b.direction === "inbound" ? 1 : 2;
    if (dirA !== dirB) return dirA - dirB;
    return a.peer.localeCompare(b.peer);
  });

  return out;
}

export function getNetworkStats(): NetworkStats {
  const peers = getNetworkPeerStats();
  let inboundOpen = 0;
  let outboundOpen = 0;
  let bestRemoteHeight = chain().height();

  for (const p of peers) {
    if (p.direction === "inbound") inboundOpen++;
    if (p.direction === "outbound") outboundOpen++;
    if (typeof p.remoteHeight === "number" && p.remoteHeight > bestRemoteHeight) {
      bestRemoteHeight = p.remoteHeight;
    }
  }

  const localHeight = chain().height();
  const syncTargetHeight = Math.max(localHeight, bestRemoteHeight);
  const lagBlocks = Math.max(0, syncTargetHeight - localHeight);
  const syncProgressPct =
    syncTargetHeight <= 0 ? 100 : Number(((localHeight / Math.max(1, syncTargetHeight)) * 100).toFixed(2));

  return {
    startedAt: networkStartedAt,
    localPort,
    localHost,
    advertisedPeerUrl,
    p2pListening: !!wss,
    tls: getP2PTlsStats(p2pTlsConfig, p2pScheme),
    publicSeeds: getPublicSeedStats(),
    checkpointSigning: getBootstrapCheckpointSigningStats(),
    socketsOpen: sockets.size,
    inboundOpen,
    outboundOpen,
    knownPeers: knownPeers.size,
    peerTableSize: peerTable.size,
    reconnectScheduled: reconnectTimers.size,
    bannedIps: Array.from(banUntil.values()).filter((until) => until > Date.now()).length,
    snapshotBootstrap: {
      ...snapshotBootstrap,
      lastCompletedAt: snapshotLastCompletedAt,
    },
    sync: {
      localHeight,
      bestRemoteHeight,
      syncTargetHeight,
      syncProgressPct,
      lagBlocks,
      lastHeadersCommonHeight: networkStats.lastHeadersCommonHeight,
      lastHeadersRemoteHeight: networkStats.lastHeadersRemoteHeight,
      lastChunkFromHeight: networkStats.lastChunkFromHeight,
      lastChunkSize: networkStats.lastChunkSize,
      lastChunkAppliedHeight: networkStats.lastChunkAppliedHeight,
      lastChunkAt: networkStats.lastChunkAt,
      activeSyncPeer,
    },
    traffic: {
      messagesReceived: networkStats.messagesReceived,
      messagesSent: networkStats.messagesSent,
      bytesReceivedApprox: networkStats.bytesReceivedApprox,
      bytesSentApprox: networkStats.bytesSentApprox,
      compressedMessagesReceived: networkStats.compressedMessagesReceived,
      compressedMessagesSent: networkStats.compressedMessagesSent,
    },
    counters: {
      discoveryDials: networkStats.discoveryDials,
      heartbeatPingsSent: networkStats.heartbeatPingsSent,
      staleSocketsClosed: networkStats.staleSocketsClosed,
      reconnectAttempts: networkStats.reconnectAttempts,
      reconnectScheduled: networkStats.reconnectScheduled,
      rateLimitRejects: networkStats.rateLimitRejects,
      bansIssued: networkStats.bansIssued,
      badMessages: networkStats.badMessages,
      bandwidthInboundAllowed: networkStats.bandwidthInboundAllowed,
      bandwidthInboundRejected: networkStats.bandwidthInboundRejected,
      bandwidthOutboundAllowed: networkStats.bandwidthOutboundAllowed,
      bandwidthOutboundRejected: networkStats.bandwidthOutboundRejected,
      bandwidthBytesDroppedApprox: networkStats.bandwidthBytesDroppedApprox,
      tlsServerEnabled: networkStats.tlsServerEnabled,
      tlsClientDials: networkStats.tlsClientDials,
      tlsClientErrors: networkStats.tlsClientErrors,
      publicSeedDials: networkStats.publicSeedDials,
      publicSeedDialErrors: networkStats.publicSeedDialErrors,
      checkpointSignaturesCreated: networkStats.checkpointSignaturesCreated,
      checkpointSignaturesVerified: networkStats.checkpointSignaturesVerified,
      checkpointSignatureRejects: networkStats.checkpointSignatureRejects,
      checkpointUnsignedAccepted: networkStats.checkpointUnsignedAccepted,
      headersResponsesSeen: networkStats.headersResponsesSeen,
      blockRangeResponsesSeen: networkStats.blockRangeResponsesSeen,
      initialBlockDownloadRequests: networkStats.initialBlockDownloadRequests,
      initialBlockDownloadBlocks: networkStats.initialBlockDownloadBlocks,
      initialBlockDownloadAdaptiveUpshifts: networkStats.initialBlockDownloadAdaptiveUpshifts,
      initialBlockDownloadAdaptiveDownshifts: networkStats.initialBlockDownloadAdaptiveDownshifts,
      initialBlockDownloadFastChunks: networkStats.initialBlockDownloadFastChunks,
      initialBlockDownloadRetryHeaders: networkStats.initialBlockDownloadRetryHeaders,
      initialBlockDownloadLastChunkMs: networkStats.initialBlockDownloadLastChunkMs,
      txAccepted: networkStats.txAccepted,
      txRejected: networkStats.txRejected,
      txInvReceived: networkStats.txInvReceived,
      txBatchReceived: networkStats.txBatchReceived,
      mempoolRequestsSent: networkStats.mempoolRequestsSent,
      mempoolResponsesReceived: networkStats.mempoolResponsesReceived,
      snapshotMetaRequestsSent: networkStats.snapshotMetaRequestsSent,
      snapshotMetaResponsesReceived: networkStats.snapshotMetaResponsesReceived,
      snapshotRequestsSent: networkStats.snapshotRequestsSent,
      snapshotResponsesReceived: networkStats.snapshotResponsesReceived,
      snapshotImportsSucceeded: networkStats.snapshotImportsSucceeded,
      snapshotImportsFailed: networkStats.snapshotImportsFailed,
      snapshotResponsePlainSent: networkStats.snapshotResponsePlainSent,
      snapshotResponseCompressedSent: networkStats.snapshotResponseCompressedSent,
      snapshotResponseRawBytes: networkStats.snapshotResponseRawBytes,
      snapshotResponsePackedBytes: networkStats.snapshotResponsePackedBytes,
      snapshotResponseSavedBytes: networkStats.snapshotResponseSavedBytes,
      snapshotResponseCompressionMs: networkStats.snapshotResponseCompressionMs,
      snapshotMetaRawBytes: networkStats.snapshotMetaRawBytes,
      snapshotMetaPackedBytes: networkStats.snapshotMetaPackedBytes,
      compactReceived: networkStats.compactReceived,
      compactAccepted: networkStats.compactAccepted,
      compactRejected: networkStats.compactRejected,
      compactStalled: networkStats.compactStalled,
      compactRecoveredFromMempool: networkStats.compactRecoveredFromMempool,
      compactTxRequestsSent: networkStats.compactTxRequestsSent,
      compactTxsRequested: networkStats.compactTxsRequested,
      compactTxBatchesReceived: networkStats.compactTxBatchesReceived,
      compactTxsRecovered: networkStats.compactTxsRecovered,
      compactFullFallbacks: networkStats.compactFullFallbacks,
      fullBlockReceived: networkStats.fullBlockReceived,
      fullBlockAccepted: networkStats.fullBlockAccepted,
      fullBlockRejected: networkStats.fullBlockRejected,
      orphanStored: networkStats.orphanStored,
      orphanResolvedApprox: networkStats.orphanResolvedApprox,
    },
    reputation: reputationSummary(),
    bandwidth: bandwidthThrottle.summary(),
    peers,
  };
}

export function startServer(args: { port: number; host?: string; advertiseUrl?: string | null }) {
  localPort = args.port;
  localHost = args.host || "127.0.0.1";
  p2pTlsConfig = loadP2PTlsConfig();
  p2pScheme = p2pTlsConfig.enabled ? "wss" : "ws";
  advertisedPeerUrl = normalizeWsUrl(args.advertiseUrl || "") || null;
  networkStartedAt = Date.now();
  networkStats.tlsServerEnabled = p2pTlsConfig.enabled ? 1 : 0;

  loadPeerTable();

  for (const p of Array.from(peerTable)) {
    if (isSelfPeerUrl(p)) {
      peerTable.delete(p);
      knownPeers.delete(p);
    }
  }
  savePeerTable();

  if (p2pTlsConfig.enabled) {
    const tlsOptions = buildP2PTlsServerOptions(p2pTlsConfig);
    tlsHttpsServer = https.createServer(tlsOptions);
    wss = new WebSocketServer({
      server: tlsHttpsServer,
      maxPayload: MAX_MSG_BYTES,
    });
    tlsHttpsServer.listen(localPort, localHost);
  } else {
    tlsHttpsServer = null;
    wss = new WebSocketServer({
      port: localPort,
      host: localHost,
      maxPayload: MAX_MSG_BYTES,
    });
  }

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress || "unknown";
    const remotePort = req.socket.remotePort || 0;
    const normalizedIp = normalizeHostAlias(ip);
    const selfInbound = isLoopbackHost(normalizedIp) && remotePort === localPort;

    if (selfInbound) {
      console.log(`↪️ inbound self-connection closed ${ip}:${remotePort}`);
      try {
        ws.close(1000, "self-peer");
      } catch {}
      return;
    }

    if (banned(ip)) {
      console.log(`🚫 inbound reject banned ip=${ip}`);
      try {
        ws.close(1008, "banned");
      } catch {}
      return;
    }

    const cur = inboundByIp.get(ip) ?? 0;
    if (cur >= MAX_INBOUND_PER_IP) {
      console.log(`🚫 inbound reject per-ip-limit ip=${ip} count=${cur}/${MAX_INBOUND_PER_IP}`);
      try {
        ws.close(1008, "per-ip-limit");
      } catch {}
      return;
    }

    inboundByIp.set(ip, cur + 1);
    console.log(`📥 inbound connected ${ip}:${req.socket.remotePort}`);

    wireSocket(ws);
    onSocketOpen(ws);
  });

  wss.on("listening", () => {
    console.log(`🌐 P2P listening on ${p2pScheme}://${localHost}:${localPort}`);
    if (p2pTlsConfig.enabled) {
      console.log(`🔐 P2P TLS enabled | cert=${p2pTlsConfig.certFile || "(inline/env)"} | key=${p2pTlsConfig.keyFile || "(inline/env)"}`);
    }
    if (advertisedPeerUrl) console.log(`📣 advertising peer ${advertisedPeerUrl}`);
  });

  runDiscoveryLoop();
  runHeartbeatLoop();
}