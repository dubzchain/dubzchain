// telemetry.ts

/* =========================
   Metrics / Telemetry System
   Phase 9.17
========================= */

export type TelemetryMode = "local" | "public" | "disabled";

export type TelemetryConfig = {
  enabled: boolean;
  mode: TelemetryMode;
  includeProcess: boolean;
  includeNetwork: boolean;
  includeStorage: boolean;
  includeRecentEvents: boolean;
  maxRecentEvents: number;
  metricsPrefix: string;
  startedAt: number;
};

export type TelemetryEvent = {
  ts: number;
  name: string;
  value: number;
  labels: Record<string, string>;
};

export type TelemetryRequestInput = {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  bytes: number;
};

export type TelemetryRequestBucket = {
  key: string;
  method: string;
  path: string;
  count: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  totalDurationMs: number;
  maxDurationMs: number;
  avgDurationMs: number;
  totalBytes: number;
  lastStatusCode: number;
  lastSeenAt: number;
};

export type TelemetryStats = {
  enabled: boolean;
  mode: TelemetryMode;
  metricsPrefix: string;
  startedAt: number;
  uptimeMs: number;
  totalRequests: number;
  totalErrors: number;
  totalBytes: number;
  avgRequestMs: number;
  maxRequestMs: number;
  lastRequestAt: number;
  lastRequestPath: string | null;
  lastRequestStatusCode: number | null;
  requestBuckets: TelemetryRequestBucket[];
  recentEvents: TelemetryEvent[];
};

export type TelemetrySnapshotInput = {
  node?: Record<string, any>;
  chain?: Record<string, any>;
  network?: Record<string, any>;
  storage?: Record<string, any>;
  process?: Record<string, any>;
  rpcAuth?: Record<string, any>;
  explorerDeployment?: Record<string, any>;
};

function now() {
  return Date.now();
}

function boolFromEnv(name: string, fallback: boolean) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function intFromEnv(name: string, fallback: number, lo: number, hi: number) {
  const raw = process.env[name];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function modeFromEnv(): TelemetryMode {
  const raw = String(process.env.DUBZ_TELEMETRY_MODE || "local").trim().toLowerCase();
  if (raw === "public") return "public";
  if (raw === "disabled") return "disabled";
  return "local";
}

function sanitizeMetricName(s: string) {
  return String(s || "dubzchain")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^([^a-z_])/, "_$1") || "dubzchain";
}

function labelValue(v: any) {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n");
}

function finiteNumber(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function requestBucketKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

let config: TelemetryConfig = createTelemetryConfigFromEnv();
let totalRequests = 0;
let totalErrors = 0;
let totalBytes = 0;
let totalDurationMs = 0;
let maxRequestMs = 0;
let lastRequestAt = 0;
let lastRequestPath: string | null = null;
let lastRequestStatusCode: number | null = null;

const requestBuckets = new Map<string, TelemetryRequestBucket>();
const recentEvents: TelemetryEvent[] = [];

function createTelemetryConfigFromEnv(): TelemetryConfig {
  const mode = modeFromEnv();
  const enabled = mode !== "disabled" && boolFromEnv("DUBZ_TELEMETRY", true);

  return {
    enabled,
    mode: enabled ? mode : "disabled",
    includeProcess: boolFromEnv("DUBZ_TELEMETRY_PROCESS", true),
    includeNetwork: boolFromEnv("DUBZ_TELEMETRY_NETWORK", true),
    includeStorage: boolFromEnv("DUBZ_TELEMETRY_STORAGE", true),
    includeRecentEvents: boolFromEnv("DUBZ_TELEMETRY_EVENTS", true),
    maxRecentEvents: intFromEnv("DUBZ_TELEMETRY_MAX_EVENTS", 100, 0, 10_000),
    metricsPrefix: sanitizeMetricName(process.env.DUBZ_TELEMETRY_PREFIX || "dubzchain"),
    startedAt: now(),
  };
}

export function createTelemetryConfig(): TelemetryConfig {
  config = createTelemetryConfigFromEnv();
  return getTelemetryConfig();
}

export function getTelemetryConfig(): TelemetryConfig {
  return { ...config };
}

export function recordTelemetryEvent(name: string, value = 1, labels: Record<string, string> = {}) {
  if (!config.enabled || !config.includeRecentEvents) return;

  recentEvents.unshift({
    ts: now(),
    name,
    value,
    labels: { ...labels },
  });

  while (recentEvents.length > config.maxRecentEvents) recentEvents.pop();
}

export function recordTelemetryRequest(input: TelemetryRequestInput) {
  if (!config.enabled) return;

  const method = String(input.method || "GET").toUpperCase();
  const path = String(input.path || "/");
  const statusCode = Math.floor(finiteNumber(input.statusCode, 0));
  const durationMs = Math.max(0, finiteNumber(input.durationMs, 0));
  const bytes = Math.max(0, finiteNumber(input.bytes, 0));

  totalRequests++;
  totalBytes += bytes;
  totalDurationMs += durationMs;
  maxRequestMs = Math.max(maxRequestMs, durationMs);
  lastRequestAt = now();
  lastRequestPath = path;
  lastRequestStatusCode = statusCode;

  if (statusCode >= 400) totalErrors++;

  const key = requestBucketKey(method, path);
  const bucket =
    requestBuckets.get(key) ??
    {
      key,
      method,
      path,
      count: 0,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      avgDurationMs: 0,
      totalBytes: 0,
      lastStatusCode: 0,
      lastSeenAt: 0,
    };

  bucket.count++;
  bucket.totalDurationMs += durationMs;
  bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
  bucket.avgDurationMs = bucket.count > 0 ? bucket.totalDurationMs / bucket.count : 0;
  bucket.totalBytes += bytes;
  bucket.lastStatusCode = statusCode;
  bucket.lastSeenAt = lastRequestAt;

  if (statusCode >= 200 && statusCode < 300) bucket.status2xx++;
  else if (statusCode >= 300 && statusCode < 400) bucket.status3xx++;
  else if (statusCode >= 400 && statusCode < 500) bucket.status4xx++;
  else if (statusCode >= 500) bucket.status5xx++;

  requestBuckets.set(key, bucket);

  if (statusCode >= 500) {
    recordTelemetryEvent("rpc_server_error", 1, { method, path, statusCode: String(statusCode) });
  }
}

export function getTelemetryStats(): TelemetryStats {
  const uptimeMs = now() - config.startedAt;
  const buckets = Array.from(requestBuckets.values()).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    enabled: config.enabled,
    mode: config.mode,
    metricsPrefix: config.metricsPrefix,
    startedAt: config.startedAt,
    uptimeMs,
    totalRequests,
    totalErrors,
    totalBytes,
    avgRequestMs: totalRequests > 0 ? totalDurationMs / totalRequests : 0,
    maxRequestMs,
    lastRequestAt,
    lastRequestPath,
    lastRequestStatusCode,
    requestBuckets: buckets,
    recentEvents: recentEvents.slice(),
  };
}

export function buildTelemetrySnapshot(input: TelemetrySnapshotInput = {}) {
  const stats = getTelemetryStats();

  return {
    ok: true,
    telemetry: {
      config: getTelemetryConfig(),
      stats,
      gauges: {
        node: input.node ?? null,
        chain: input.chain ?? null,
        network: config.includeNetwork ? input.network ?? null : null,
        storage: config.includeStorage ? input.storage ?? null : null,
        process: config.includeProcess ? input.process ?? null : null,
        rpcAuth: input.rpcAuth ?? null,
        explorerDeployment: input.explorerDeployment ?? null,
      },
    },
  };
}

export function buildTelemetryMetricsText(input: TelemetrySnapshotInput = {}) {
  const stats = getTelemetryStats();
  const prefix = config.metricsPrefix || "dubzchain";
  const chain = input.chain ?? {};
  const network = input.network ?? {};
  const storage = input.storage ?? {};
  const proc = input.process ?? {};
  const rpcAuth = input.rpcAuth ?? {};
  const explorer = input.explorerDeployment ?? {};

  const lines: string[] = [];

  lines.push(`# HELP ${prefix}_telemetry_enabled Whether telemetry collection is enabled.`);
  lines.push(`# TYPE ${prefix}_telemetry_enabled gauge`);
  lines.push(`${prefix}_telemetry_enabled ${stats.enabled ? 1 : 0}`);
  lines.push(`${prefix}_telemetry_uptime_ms ${stats.uptimeMs}`);
  lines.push(`${prefix}_telemetry_requests_total ${stats.totalRequests}`);
  lines.push(`${prefix}_telemetry_errors_total ${stats.totalErrors}`);
  lines.push(`${prefix}_telemetry_response_bytes_total ${stats.totalBytes}`);
  lines.push(`${prefix}_telemetry_request_avg_ms ${stats.avgRequestMs}`);
  lines.push(`${prefix}_telemetry_request_max_ms ${stats.maxRequestMs}`);
  lines.push(`${prefix}_telemetry_last_request_at_ms ${stats.lastRequestAt}`);

  lines.push(`${prefix}_chain_height ${finiteNumber(chain.height)}`);
  lines.push(`${prefix}_chain_mempool_size ${finiteNumber(chain.mempoolSize)}`);
  lines.push(`${prefix}_chain_orphan_count ${finiteNumber(chain.orphanCount)}`);
  lines.push(`${prefix}_chain_minted_supply ${finiteNumber(chain.minted)}`);
  lines.push(`${prefix}_chain_reward_now ${finiteNumber(chain.rewardNow)}`);
  lines.push(`${prefix}_network_sockets_open ${finiteNumber(network.socketsOpen)}`);
  lines.push(`${prefix}_network_sync_progress_pct ${finiteNumber(network.sync?.syncProgressPct)}`);
  lines.push(`${prefix}_network_sync_lag_blocks ${finiteNumber(network.sync?.lagBlocks)}`);
  lines.push(`${prefix}_storage_checkpoint_height ${finiteNumber(storage.checkpointHeight)}`);
  lines.push(`${prefix}_storage_local_blocks ${finiteNumber(storage.localBlocks)}`);
  lines.push(`${prefix}_process_rss_bytes ${finiteNumber(proc.rssBytes)}`);
  lines.push(`${prefix}_process_heap_used_bytes ${finiteNumber(proc.heapUsedBytes)}`);
  lines.push(`${prefix}_rpc_auth_enabled ${rpcAuth.enabled ? 1 : 0}`);
  lines.push(`${prefix}_explorer_public_ready ${explorer.publicReady ? 1 : 0}`);

  for (const bucket of stats.requestBuckets.slice(0, 100)) {
    const labels = `method="${labelValue(bucket.method)}",path="${labelValue(bucket.path)}"`;
    lines.push(`${prefix}_rpc_requests_total{${labels}} ${bucket.count}`);
    lines.push(`${prefix}_rpc_request_avg_ms{${labels}} ${bucket.avgDurationMs}`);
    lines.push(`${prefix}_rpc_request_max_ms{${labels}} ${bucket.maxDurationMs}`);
    lines.push(`${prefix}_rpc_response_bytes_total{${labels}} ${bucket.totalBytes}`);
    lines.push(`${prefix}_rpc_status_2xx_total{${labels}} ${bucket.status2xx}`);
    lines.push(`${prefix}_rpc_status_3xx_total{${labels}} ${bucket.status3xx}`);
    lines.push(`${prefix}_rpc_status_4xx_total{${labels}} ${bucket.status4xx}`);
    lines.push(`${prefix}_rpc_status_5xx_total{${labels}} ${bucket.status5xx}`);
  }

  return lines.join("\n") + "\n";
}
