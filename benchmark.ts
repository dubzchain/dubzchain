// benchmark.ts
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import { URL } from "url";
import WebSocket from "ws";

/* =========================
   DubzChain Node Benchmark Suite
   Phase 9.18
========================= */

type EndpointResult = {
  endpoint: string;
  method: "GET";
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  bytes: number;
  durationMs: number;
};

type EndpointSummary = {
  endpoint: string;
  method: "GET";
  requests: number;
  ok: number;
  errors: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  bytes: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  sampleErrors: string[];
};

type WebSocketResult = {
  url: string;
  attempts: number;
  connected: number;
  failed: number;
  avgConnectMs: number | null;
  maxConnectMs: number | null;
  sampleErrors: string[];
};

type BenchmarkConfig = {
  baseUrl: string;
  p2pUrl: string | null;
  rounds: number;
  concurrency: number;
  timeoutMs: number;
  includeRaw: boolean;
  outputJson: string;
  outputMarkdown: string;
  endpoints: string[];
  apiKey: string | null;
  rejectUnauthorized: boolean;
};

type BenchmarkReport = {
  ok: boolean;
  suite: string;
  version: number;
  createdAt: number;
  createdAtIso: string;
  config: BenchmarkConfig;
  totals: {
    requests: number;
    ok: number;
    errors: number;
    bytes: number;
    durationMs: number;
    requestsPerSecond: number;
    avgMs: number;
    p95Ms: number;
    p99Ms: number;
  };
  endpoints: EndpointSummary[];
  websocket: WebSocketResult | null;
  recommendations: string[];
  raw?: EndpointResult[];
};

const DEFAULT_ENDPOINTS = [
  "/health",
  "/status",
  "/peers",
  "/storage",
  "/diagnostics/network",
  "/diagnostics",
  "/telemetry",
  "/telemetry/events",
  "/metrics",
  "/deployment",
];

function now() {
  return Date.now();
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return null;
}

function argHas(argv: string[], flag: string) {
  return argv.includes(flag);
}

function parseIntArg(argv: string[], flag: string, fallback: number, min: number, max: number) {
  const raw = argValue(argv, flag);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseConfig(): BenchmarkConfig {
  const argv = process.argv.slice(2);

  const baseUrl = argValue(argv, "--base") || argValue(argv, "--base-url") || "http://127.0.0.1:4001";
  const p2pUrl = argValue(argv, "--p2p") || argValue(argv, "--p2p-url");
  const rounds = parseIntArg(argv, "--rounds", 10, 1, 10_000);
  const concurrency = parseIntArg(argv, "--concurrency", 4, 1, 256);
  const timeoutMs = parseIntArg(argv, "--timeout-ms", 5000, 250, 120_000);
  const outputJson = argValue(argv, "--out") || "benchmark.json";
  const outputMarkdown = argValue(argv, "--md") || "benchmark.md";
  const apiKey = argValue(argv, "--api-key") || process.env.DUBZ_RPC_API_KEY || null;
  const rejectUnauthorized = !argHas(argv, "--allow-self-signed");

  const endpointsRaw = argValue(argv, "--endpoints");
  const endpoints = endpointsRaw
    ? endpointsRaw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (x.startsWith("/") ? x : `/${x}`))
    : DEFAULT_ENDPOINTS.slice();

  return {
    baseUrl,
    p2pUrl,
    rounds,
    concurrency,
    timeoutMs,
    includeRaw: argHas(argv, "--include-raw"),
    outputJson,
    outputMarkdown,
    endpoints,
    apiKey,
    rejectUnauthorized,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(n: number, digits = 3) {
  if (!Number.isFinite(n)) return 0;
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

function statusBucket(statusCode: number | null) {
  if (!statusCode) return "error";
  if (statusCode >= 200 && statusCode <= 299) return "2xx";
  if (statusCode >= 300 && statusCode <= 399) return "3xx";
  if (statusCode >= 400 && statusCode <= 499) return "4xx";
  if (statusCode >= 500 && statusCode <= 599) return "5xx";
  return "error";
}

function safeUrl(baseUrl: string, endpoint: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  return new URL(cleanEndpoint, base);
}

function requestEndpoint(config: BenchmarkConfig, endpoint: string): Promise<EndpointResult> {
  const startedAt = now();
  const url = safeUrl(config.baseUrl, endpoint);
  const isHttps = url.protocol === "https:";

  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      "user-agent": "dubzchain-benchmark/1.0",
      accept: "*/*",
    };

    if (config.apiKey) {
      headers["x-api-key"] = config.apiKey;
      headers["authorization"] = `Bearer ${config.apiKey}`;
    }

    const options: http.RequestOptions | https.RequestOptions = {
      method: "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: config.timeoutMs,
    };

    if (isHttps) {
      (options as https.RequestOptions).rejectUnauthorized = config.rejectUnauthorized;
    }

    const client = isHttps ? https : http;
    let settled = false;

    const finish = (out: EndpointResult) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };

    const req = client.request(options, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        chunks.push(buf);
      });

      res.on("end", () => {
        const statusCode = res.statusCode ?? null;
        const bodyBytes = totalBytes || Buffer.concat(chunks).length;
        const ok = !!statusCode && statusCode >= 200 && statusCode < 300;

        finish({
          endpoint,
          method: "GET",
          statusCode,
          ok,
          error: ok ? null : `HTTP ${statusCode ?? "unknown"}`,
          bytes: bodyBytes,
          durationMs: now() - startedAt,
        });
      });
    });

    req.on("timeout", () => {
      try {
        req.destroy(new Error(`timeout after ${config.timeoutMs}ms`));
      } catch {}
    });

    req.on("error", (err: any) => {
      finish({
        endpoint,
        method: "GET",
        statusCode: null,
        ok: false,
        error: err?.message ?? String(err),
        bytes: 0,
        durationMs: now() - startedAt,
      });
    });

    req.end();
  });
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let idx = 0;
  const workers: Promise<void>[] = [];

  const worker = async () => {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item);
    }
  };

  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
}

async function benchmarkHttp(config: BenchmarkConfig): Promise<EndpointResult[]> {
  const work: string[] = [];
  for (let r = 0; r < config.rounds; r++) {
    for (const endpoint of config.endpoints) work.push(endpoint);
  }

  const results: EndpointResult[] = [];
  await runPool(work, config.concurrency, async (endpoint) => {
    const result = await requestEndpoint(config, endpoint);
    results.push(result);
  });

  return results;
}

function summarizeEndpoint(endpoint: string, results: EndpointResult[]): EndpointSummary {
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const bytes = results.reduce((s, r) => s + r.bytes, 0);
  const ok = results.filter((r) => r.ok).length;
  const errors = results.length - ok;

  const sampleErrors = Array.from(
    new Set(
      results
        .filter((r) => !r.ok)
        .map((r) => r.error || `HTTP ${r.statusCode ?? "unknown"}`)
        .slice(0, 5)
    )
  );

  return {
    endpoint,
    method: "GET",
    requests: results.length,
    ok,
    errors,
    status2xx: results.filter((r) => statusBucket(r.statusCode) === "2xx").length,
    status3xx: results.filter((r) => statusBucket(r.statusCode) === "3xx").length,
    status4xx: results.filter((r) => statusBucket(r.statusCode) === "4xx").length,
    status5xx: results.filter((r) => statusBucket(r.statusCode) === "5xx").length,
    bytes,
    minMs: durations.length ? durations[0] : 0,
    maxMs: durations.length ? durations[durations.length - 1] : 0,
    avgMs: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 3) : 0,
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    sampleErrors,
  };
}

function summarizeTotals(results: EndpointResult[], durationMs: number) {
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const ok = results.filter((r) => r.ok).length;
  const errors = results.length - ok;
  const bytes = results.reduce((s, r) => s + r.bytes, 0);

  return {
    requests: results.length,
    ok,
    errors,
    bytes,
    durationMs,
    requestsPerSecond: durationMs > 0 ? round((results.length / durationMs) * 1000, 3) : 0,
    avgMs: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 3) : 0,
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
  };
}

function websocketAttempt(url: string, timeoutMs: number, rejectUnauthorized: boolean): Promise<{ ok: boolean; ms: number; error: string | null }> {
  const startedAt = now();

  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok: boolean, error: string | null, ws?: WebSocket) => {
      if (settled) return;
      settled = true;

      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      } catch {}

      resolve({
        ok,
        ms: now() - startedAt,
        error,
      });
    };

    try {
      const ws = new WebSocket(url, {
        handshakeTimeout: timeoutMs,
        rejectUnauthorized,
      } as any);

      const timer = setTimeout(() => {
        finish(false, `timeout after ${timeoutMs}ms`, ws);
      }, timeoutMs + 250);

      ws.on("open", () => {
        clearTimeout(timer);
        finish(true, null, ws);
      });

      ws.on("error", (err: any) => {
        clearTimeout(timer);
        finish(false, err?.message ?? String(err), ws);
      });

      ws.on("close", () => {
        clearTimeout(timer);
        if (!settled) finish(false, "closed before open", ws);
      });
    } catch (e: any) {
      finish(false, e?.message ?? String(e));
    }
  });
}

async function benchmarkWebSocket(config: BenchmarkConfig): Promise<WebSocketResult | null> {
  if (!config.p2pUrl) return null;

  const attempts = Math.min(10, Math.max(1, config.rounds));
  const results = [];

  for (let i = 0; i < attempts; i++) {
    results.push(await websocketAttempt(config.p2pUrl, config.timeoutMs, config.rejectUnauthorized));
    await sleep(25);
  }

  const connected = results.filter((r) => r.ok).length;
  const failed = results.length - connected;
  const connectedMs = results.filter((r) => r.ok).map((r) => r.ms);
  const sampleErrors = Array.from(new Set(results.filter((r) => !r.ok).map((r) => r.error || "unknown").slice(0, 5)));

  return {
    url: config.p2pUrl,
    attempts,
    connected,
    failed,
    avgConnectMs: connectedMs.length ? round(connectedMs.reduce((a, b) => a + b, 0) / connectedMs.length, 3) : null,
    maxConnectMs: connectedMs.length ? Math.max(...connectedMs) : null,
    sampleErrors,
  };
}

function buildRecommendations(report: BenchmarkReport): string[] {
  const out: string[] = [];

  if (report.totals.errors > 0) {
    out.push(`Investigate ${report.totals.errors} non-2xx or failed RPC benchmark requests.`);
  } else {
    out.push("RPC endpoint benchmark passed with zero request errors.");
  }

  if (report.totals.p95Ms > 1000) {
    out.push(`RPC P95 latency is high at ${report.totals.p95Ms}ms. Check CPU load, disk writes, and endpoint payload sizes.`);
  } else if (report.totals.p95Ms > 250) {
    out.push(`RPC P95 latency is moderate at ${report.totals.p95Ms}ms. Watch /diagnostics and /metrics under heavier load.`);
  } else {
    out.push(`RPC latency looks healthy. P95=${report.totals.p95Ms}ms.`);
  }

  if (report.websocket) {
    if (report.websocket.failed > 0) {
      out.push(
        `P2P WebSocket benchmark had ${report.websocket.failed} failed connection attempt(s). Check ws/wss scheme, TLS cert trust, and peer URL.`
      );
      if (report.websocket.sampleErrors.length) {
        out.push(`WebSocket sample error: ${report.websocket.sampleErrors[0]}`);
      }
    } else {
      out.push(`P2P WebSocket connect benchmark passed. Avg connect=${report.websocket.avgConnectMs}ms.`);
    }
  }

  const largest = report.endpoints.slice().sort((a, b) => b.bytes - a.bytes)[0];
  if (largest && largest.bytes > 0) {
    out.push(`Largest endpoint by total bytes: ${largest.endpoint} (${largest.bytes} bytes over ${largest.requests} request(s)).`);
  }

  return out;
}

function renderMarkdown(report: BenchmarkReport) {
  const lines: string[] = [];

  lines.push("# DubzChain Performance Benchmark Report");
  lines.push("");
  lines.push(`Created: ${report.createdAtIso}`);
  lines.push(`Base URL: ${report.config.baseUrl}`);
  lines.push(`P2P URL: ${report.config.p2pUrl ?? "(none)"}`);
  lines.push(`Rounds: ${report.config.rounds}`);
  lines.push(`Concurrency: ${report.config.concurrency}`);
  lines.push(`Timeout: ${report.config.timeoutMs}ms`);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Requests: ${report.totals.requests}`);
  lines.push(`- OK: ${report.totals.ok}`);
  lines.push(`- Errors: ${report.totals.errors}`);
  lines.push(`- Bytes: ${report.totals.bytes}`);
  lines.push(`- Duration: ${report.totals.durationMs}ms`);
  lines.push(`- Requests/sec: ${report.totals.requestsPerSecond}`);
  lines.push(`- Average latency: ${report.totals.avgMs}ms`);
  lines.push(`- P95 latency: ${report.totals.p95Ms}ms`);
  lines.push(`- P99 latency: ${report.totals.p99Ms}ms`);
  lines.push("");
  lines.push("## Endpoint Summary");
  lines.push("");
  lines.push("| Endpoint | Requests | OK | Errors | 2xx | 4xx | 5xx | Avg ms | P95 ms | P99 ms | Bytes | Sample errors |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");

  for (const ep of report.endpoints) {
    lines.push(
      `| ${ep.endpoint} | ${ep.requests} | ${ep.ok} | ${ep.errors} | ${ep.status2xx} | ${ep.status4xx} | ${ep.status5xx} | ${ep.avgMs} | ${ep.p95Ms} | ${ep.p99Ms} | ${ep.bytes} | ${ep.sampleErrors.join("; ") || "-"} |`
    );
  }

  lines.push("");
  lines.push("## WebSocket");
  lines.push("");

  if (!report.websocket) {
    lines.push("- Not tested.");
  } else {
    lines.push(`- URL: ${report.websocket.url}`);
    lines.push(`- Attempts: ${report.websocket.attempts}`);
    lines.push(`- Connected: ${report.websocket.connected}`);
    lines.push(`- Failed: ${report.websocket.failed}`);
    lines.push(`- Avg connect ms: ${report.websocket.avgConnectMs ?? "n/a"}`);
    lines.push(`- Max connect ms: ${report.websocket.maxConnectMs ?? "n/a"}`);
    if (report.websocket.sampleErrors.length) {
      lines.push(`- Sample errors: ${report.websocket.sampleErrors.join("; ")}`);
    }
  }

  lines.push("");
  lines.push("## Recommendations");
  lines.push("");

  for (const rec of report.recommendations) {
    lines.push(`- ${rec}`);
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  const config = parseConfig();
  const startedAt = now();

  console.log(
    `🧪 DubzChain benchmark start | base=${config.baseUrl} | requests=${config.rounds * config.endpoints.length} | concurrency=${config.concurrency}`
  );

  const results = await benchmarkHttp(config);
  const durationMs = now() - startedAt;

  const endpointSummaries = config.endpoints.map((endpoint) =>
    summarizeEndpoint(
      endpoint,
      results.filter((r) => r.endpoint === endpoint)
    )
  );

  const wsResult = await benchmarkWebSocket(config);

  const report: BenchmarkReport = {
    ok: results.every((r) => r.ok) && (!wsResult || wsResult.failed === 0),
    suite: "dubzchain-performance-benchmark",
    version: 2,
    createdAt: now(),
    createdAtIso: new Date().toISOString(),
    config,
    totals: summarizeTotals(results, durationMs),
    endpoints: endpointSummaries,
    websocket: wsResult,
    recommendations: [],
  };

  report.recommendations = buildRecommendations(report);

  if (config.includeRaw) {
    report.raw = results;
  }

  fs.writeFileSync(config.outputJson, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(config.outputMarkdown, renderMarkdown(report), "utf8");

  console.log(
    `✅ benchmark complete | ok=${report.ok} | requests=${report.totals.requests} | errors=${report.totals.errors} | p95=${report.totals.p95Ms}ms`
  );
  console.log(`📝 wrote ${config.outputJson}`);
  console.log(`📝 wrote ${config.outputMarkdown}`);
}

main().catch((e: any) => {
  console.error("Benchmark fatal", e?.message ?? String(e));
  process.exit(1);
});
