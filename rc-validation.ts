// rc-validation.ts
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import WebSocket from "ws";
import { URL } from "url";

/* =========================
   Release Candidate Validation
   Phase 9.20
========================= */

type JsonObj = Record<string, any>;

type RcCheckStatus = "pass" | "warn" | "fail";

type RcCheck = {
  id: string;
  title: string;
  status: RcCheckStatus;
  summary: string;
  details?: any;
};

type RcEndpointResult = {
  url: string;
  ok: boolean;
  statusCode: number;
  ms: number;
  bytes: number;
  json: any | null;
  error: string | null;
};

type RcConfig = {
  nodeName: string;
  baseUrl: string;
  p2pUrl: string | null;
  timeoutMs: number;
  outJson: string;
  outMd: string;
  allowSelfSigned: boolean;
  requireProfile: "devnet" | "testnet" | "mainnet" | "any";
  requireRpcAuthForMainnet: boolean;
  requireTlsForMainnet: boolean;
  requireCheckpointSigningForMainnet: boolean;
  requirePublicSeedsForMainnet: boolean;
};

type RcReport = {
  ok: boolean;
  suite: "dubzchain-release-candidate-validation";
  version: number;
  createdAt: number;
  createdAtIso: string;
  config: RcConfig;
  totals: {
    checks: number;
    pass: number;
    warn: number;
    fail: number;
  };
  endpoints: Record<string, RcEndpointResult>;
  checks: RcCheck[];
  recommendation: string;
};

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

function normalizeBaseUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function requestJson(url: string, timeoutMs: number, allowSelfSigned: boolean): Promise<RcEndpointResult> {
  return new Promise((resolve) => {
    const started = now();
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        timeout: timeoutMs,
        rejectUnauthorized: !allowSelfSigned,
        headers: {
          accept: "application/json,text/plain,*/*",
          "user-agent": "dubzchain-rc-validator/1.0",
        },
      } as any,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const ms = now() - started;
          const body = Buffer.concat(chunks);
          const text = body.toString("utf8");
          let parsed: any = null;

          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }

          resolve({
            url,
            ok: !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode || 0,
            ms,
            bytes: body.length,
            json: parsed,
            error: null,
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", (e: any) => {
      resolve({
        url,
        ok: false,
        statusCode: 0,
        ms: now() - started,
        bytes: 0,
        json: null,
        error: e?.message ?? String(e),
      });
    });

    req.end();
  });
}

function wsConnect(url: string, timeoutMs: number, allowSelfSigned: boolean): Promise<{
  url: string;
  ok: boolean;
  ms: number;
  error: string | null;
}> {
  return new Promise((resolve) => {
    if (!url) {
      resolve({ url, ok: false, ms: 0, error: "missing p2p url" });
      return;
    }

    const started = now();
    let done = false;

    const finish = (ok: boolean, error: string | null, ws?: WebSocket) => {
      if (done) return;
      done = true;
      try {
        if (ws) ws.close();
      } catch {}
      resolve({
        url,
        ok,
        ms: now() - started,
        error,
      });
    };

    try {
      const ws = new WebSocket(url, {
        handshakeTimeout: timeoutMs,
        rejectUnauthorized: !allowSelfSigned,
      } as any);

      const timer = setTimeout(() => {
        finish(false, "timeout", ws);
      }, timeoutMs + 250);

      ws.on("open", () => {
        clearTimeout(timer);
        finish(true, null, ws);
      });

      ws.on("error", (e: any) => {
        clearTimeout(timer);
        finish(false, e?.message ?? String(e), ws);
      });
    } catch (e: any) {
      finish(false, e?.message ?? String(e));
    }
  });
}

function get(obj: any, path: string, fallback: any = null) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else return fallback;
  }
  return cur;
}

function add(checks: RcCheck[], id: string, title: string, status: RcCheckStatus, summary: string, details?: any) {
  checks.push({ id, title, status, summary, details });
}

function isNum(n: any) {
  return typeof n === "number" && Number.isFinite(n);
}

function validateReport(config: RcConfig, endpoints: Record<string, RcEndpointResult>, wsResult: any): RcCheck[] {
  const checks: RcCheck[] = [];

  const health = endpoints.health?.json;
  const status = endpoints.status?.json;
  const diagnostics = endpoints.diagnostics?.json;
  const network = endpoints.network?.json;
  const storage = endpoints.storage?.json;
  const profile = endpoints.profile?.json;
  const deployment = endpoints.deployment?.json;
  const telemetry = endpoints.telemetry?.json;

  for (const [name, result] of Object.entries(endpoints)) {
    add(
      checks,
      `endpoint.${name}`,
      `Endpoint ${name}`,
      result.ok ? "pass" : "fail",
      result.ok ? `${result.url} returned ${result.statusCode}` : `${result.url} failed`,
      {
        statusCode: result.statusCode,
        ms: result.ms,
        bytes: result.bytes,
        error: result.error,
      }
    );
  }

  add(
    checks,
    "p2p.websocket",
    "P2P WebSocket connect",
    wsResult.ok ? "pass" : "warn",
    wsResult.ok ? `Connected to ${wsResult.url} in ${wsResult.ms}ms` : `Could not connect to ${wsResult.url}`,
    wsResult
  );

  const profileName = get(profile, "summary.activeProfile", get(profile, "profile.name", null));
  const profileOk =
    config.requireProfile === "any" ||
    profileName === config.requireProfile;

  add(
    checks,
    "profile.active",
    "Network profile",
    profileOk ? "pass" : "fail",
    profileOk
      ? `Active profile is ${profileName}`
      : `Expected profile ${config.requireProfile}, got ${profileName}`,
    get(profile, "summary", null)
  );

  const healthOk = health?.ok === true || status?.ok === true || diagnostics?.ok === true;
  add(
    checks,
    "node.health",
    "Node health",
    healthOk ? "pass" : "fail",
    healthOk ? "Node health/status endpoint is OK" : "Node health/status endpoint did not report ok:true",
    { health, statusOk: status?.ok, diagnosticsOk: diagnostics?.ok }
  );

  const chainHeight = get(diagnostics, "chain.height", get(status, "height", null));
  add(
    checks,
    "chain.height",
    "Chain height",
    isNum(chainHeight) && chainHeight >= 0 ? "pass" : "fail",
    isNum(chainHeight) ? `Height=${chainHeight}` : "Missing or invalid height",
    { chainHeight }
  );

  const mempoolSize = get(diagnostics, "chain.mempoolSize", get(status, "mempoolSize", null));
  add(
    checks,
    "chain.mempool",
    "Mempool health",
    isNum(mempoolSize) && mempoolSize >= 0 ? "pass" : "fail",
    isNum(mempoolSize) ? `Mempool size=${mempoolSize}` : "Missing mempool size",
    { mempoolSize }
  );

  const syncProgress = get(network, "network.sync.syncProgressPct", get(diagnostics, "network.sync.syncProgressPct", null));
  const lagBlocks = get(network, "network.sync.lagBlocks", get(diagnostics, "network.sync.lagBlocks", null));
  const syncOk = isNum(syncProgress) && syncProgress >= 99 && isNum(lagBlocks) && lagBlocks <= 5;
  add(
    checks,
    "network.sync",
    "Network sync",
    syncOk ? "pass" : "warn",
    syncOk ? `Sync ${syncProgress}% lag=${lagBlocks}` : `Sync not fully caught up: ${syncProgress}% lag=${lagBlocks}`,
    { syncProgress, lagBlocks }
  );

  const bansIssued = get(network, "network.counters.bansIssued", get(diagnostics, "network.counters.bansIssued", null));
  const badMessages = get(network, "network.counters.badMessages", get(diagnostics, "network.counters.badMessages", null));
  const peerSecurityOk = (bansIssued ?? 0) === 0 && (badMessages ?? 0) === 0;
  add(
    checks,
    "network.peer-security",
    "Peer security counters",
    peerSecurityOk ? "pass" : "warn",
    peerSecurityOk ? "No bans or bad messages" : `bans=${bansIssued} badMessages=${badMessages}`,
    { bansIssued, badMessages }
  );

  const tls = get(network, "network.tls", get(diagnostics, "network.tls", {}));
  const tlsEnabled = tls?.enabled === true;
  const tlsRequired = config.requireTlsForMainnet && profileName === "mainnet";
  add(
    checks,
    "security.tls",
    "TLS readiness",
    tlsRequired
      ? tlsEnabled && tls.certConfigured && tls.keyConfigured
        ? "pass"
        : "fail"
      : tlsEnabled
      ? "pass"
      : "warn",
    tlsEnabled
      ? `TLS enabled scheme=${tls.scheme}`
      : tlsRequired
      ? "TLS is required for mainnet but not enabled"
      : "TLS is not enabled for this run",
    tls
  );

  const rpcAuth = get(diagnostics, "rpcAuth", {});
  const rpcAuthRequired = config.requireRpcAuthForMainnet && profileName === "mainnet";
  add(
    checks,
    "security.rpc-auth",
    "RPC auth readiness",
    rpcAuthRequired
      ? rpcAuth?.enabled === true && (rpcAuth?.keyCount ?? 0) > 0
        ? "pass"
        : "fail"
      : rpcAuth?.enabled
      ? "pass"
      : "warn",
    rpcAuth?.enabled
      ? `RPC auth enabled keyCount=${rpcAuth.keyCount}`
      : rpcAuthRequired
      ? "RPC auth is required for mainnet but not enabled"
      : "RPC auth not enabled for this run",
    rpcAuth
  );

  const checkpointSigning = get(network, "network.checkpointSigning", get(diagnostics, "network.checkpointSigning", {}));
  const checkpointRequired = config.requireCheckpointSigningForMainnet && profileName === "mainnet";
  add(
    checks,
    "security.checkpoint-signing",
    "Checkpoint signing readiness",
    checkpointRequired
      ? checkpointSigning?.enabled && checkpointSigning?.privateKeyConfigured && checkpointSigning?.publicKeyConfigured
        ? "pass"
        : "fail"
      : checkpointSigning?.enabled
      ? "pass"
      : "warn",
    checkpointSigning?.enabled
      ? `Checkpoint signing enabled keyId=${checkpointSigning.keyId}`
      : checkpointRequired
      ? "Checkpoint signing is required for mainnet but not enabled"
      : "Checkpoint signing not enabled for this run",
    checkpointSigning
  );

  const publicSeeds = get(network, "network.publicSeeds", get(diagnostics, "network.publicSeeds", {}));
  const publicSeedsRequired = config.requirePublicSeedsForMainnet && profileName === "mainnet";
  add(
    checks,
    "network.public-seeds",
    "Public seed readiness",
    publicSeedsRequired
      ? (publicSeeds?.totalSeedCount ?? 0) > 0
        ? "pass"
        : "fail"
      : (publicSeeds?.totalSeedCount ?? 0) > 0
      ? "pass"
      : "warn",
    (publicSeeds?.totalSeedCount ?? 0) > 0
      ? `Seed count=${publicSeeds.totalSeedCount}`
      : publicSeedsRequired
      ? "Public seeds are required for mainnet but none configured"
      : "No public seeds configured for this run",
    publicSeeds
  );

  const storageObj = storage?.storage ?? diagnostics?.storage ?? {};
  const chainstate = storageObj?.chainstate;
  const asyncDisk = storageObj?.asyncDisk;
  const crashJournal = storageObj?.crashJournal;
  const chainRepair = storageObj?.chainRepair;

  add(
    checks,
    "storage.chainstate",
    "Chainstate database",
    chainstate?.exists && chainstate?.backupExists ? "pass" : "fail",
    chainstate?.exists && chainstate?.backupExists
      ? `Chainstate exists at height ${chainstate.height}`
      : "Chainstate or backup missing",
    chainstate
  );

  add(
    checks,
    "storage.async-disk",
    "Async disk queue",
    asyncDisk?.enabled && (asyncDisk?.failedJobs ?? 0) === 0 ? "pass" : "fail",
    asyncDisk?.enabled
      ? `Async disk enabled failedJobs=${asyncDisk.failedJobs}`
      : "Async disk queue is not enabled",
    asyncDisk
  );

  add(
    checks,
    "storage.crash-journal",
    "Crash journal",
    crashJournal?.exists && crashJournal?.hasOpenJournal === false ? "pass" : "fail",
    crashJournal?.exists
      ? `Crash journal status=${crashJournal.lastStatus}`
      : "Crash journal missing",
    crashJournal
  );

  add(
    checks,
    "storage.chain-repair",
    "Chain repair",
    chainRepair?.lastOk === true ? "pass" : "fail",
    chainRepair?.lastOk ? "Chain repair check passed" : "Chain repair check failed or missing",
    chainRepair
  );

  const explorerDeployment = deployment?.explorerDeployment ?? diagnostics?.explorerDeployment;
  add(
    checks,
    "explorer.deployment",
    "Explorer deployment",
    explorerDeployment?.enabled && explorerDeployment?.securityHeadersEnabled ? "pass" : "fail",
    explorerDeployment?.enabled
      ? `Explorer mode=${explorerDeployment.mode} publicReady=${explorerDeployment.publicReady}`
      : "Explorer deployment config missing",
    explorerDeployment
  );

  const telemetryObj = telemetry?.telemetry ?? diagnostics?.telemetry;
  add(
    checks,
    "telemetry.enabled",
    "Telemetry",
    telemetryObj?.config?.enabled === true || telemetryObj?.enabled === true ? "pass" : "fail",
    "Telemetry endpoint/config checked",
    telemetryObj
  );

  return checks;
}

function reportRecommendation(checks: RcCheck[]) {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");

  if (fails.length > 0) {
    return `NOT READY: ${fails.length} failing check(s). Fix all failures before release candidate approval.`;
  }

  if (warns.length > 0) {
    return `CONDITIONALLY READY: no failures, but ${warns.length} warning(s) should be reviewed.`;
  }

  return "READY: all release candidate checks passed.";
}

function makeMarkdown(report: RcReport) {
  const lines: string[] = [];

  lines.push("# DubzChain Release Candidate Validation Report");
  lines.push("");
  lines.push(`Created: ${report.createdAtIso}`);
  lines.push(`Node: ${report.config.nodeName}`);
  lines.push(`Base URL: ${report.config.baseUrl}`);
  lines.push(`P2P URL: ${report.config.p2pUrl ?? "(none)"}`);
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(report.recommendation);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Checks: ${report.totals.checks}`);
  lines.push(`- Pass: ${report.totals.pass}`);
  lines.push(`- Warn: ${report.totals.warn}`);
  lines.push(`- Fail: ${report.totals.fail}`);
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| ID | Status | Summary |");
  lines.push("|---|---:|---|");

  for (const c of report.checks) {
    lines.push(`| ${c.id} | ${c.status.toUpperCase()} | ${String(c.summary).replace(/\|/g, "\\|")} |`);
  }

  lines.push("");
  lines.push("## Endpoint Results");
  lines.push("");
  lines.push("| Endpoint | OK | Status | ms | bytes | error |");
  lines.push("|---|---:|---:|---:|---:|---|");

  for (const [name, r] of Object.entries(report.endpoints)) {
    lines.push(`| ${name} | ${r.ok ? "yes" : "no"} | ${r.statusCode} | ${r.ms} | ${r.bytes} | ${r.error ?? ""} |`);
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const baseUrl = normalizeBaseUrl(argValue(process.argv, "--base") || "http://127.0.0.1:4001");
  const p2pUrl = argValue(process.argv, "--p2p");
  const nodeName = argValue(process.argv, "--node") || "node";
  const timeoutMs = Math.max(1000, parseInt(argValue(process.argv, "--timeout-ms") || "5000", 10));
  const outJson = argValue(process.argv, "--out") || "rc-validation.json";
  const outMd = argValue(process.argv, "--md") || "rc-validation.md";
  const allowSelfSigned = argHas(process.argv, "--allow-self-signed");

  const requireProfile = (argValue(process.argv, "--require-profile") || "any") as RcConfig["requireProfile"];

  const config: RcConfig = {
    nodeName,
    baseUrl,
    p2pUrl,
    timeoutMs,
    outJson,
    outMd,
    allowSelfSigned,
    requireProfile,
    requireRpcAuthForMainnet: !argHas(process.argv, "--no-require-rpc-auth-mainnet"),
    requireTlsForMainnet: !argHas(process.argv, "--no-require-tls-mainnet"),
    requireCheckpointSigningForMainnet: !argHas(process.argv, "--no-require-checkpoint-signing-mainnet"),
    requirePublicSeedsForMainnet: !argHas(process.argv, "--no-require-public-seeds-mainnet"),
  };

  const endpointPaths: Record<string, string> = {
    health: "/health",
    status: "/status",
    profile: "/profile",
    diagnostics: "/diagnostics",
    network: "/diagnostics/network",
    storage: "/storage",
    deployment: "/deployment",
    telemetry: "/telemetry",
  };

  const endpoints: Record<string, RcEndpointResult> = {};

  for (const [name, path] of Object.entries(endpointPaths)) {
    endpoints[name] = await requestJson(baseUrl + path, timeoutMs, allowSelfSigned);
  }

  const wsResult = p2pUrl
    ? await wsConnect(p2pUrl, timeoutMs, allowSelfSigned)
    : { url: "", ok: false, ms: 0, error: "not configured" };

  const checks = validateReport(config, endpoints, wsResult);

  const totals = {
    checks: checks.length,
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };

  const report: RcReport = {
    ok: totals.fail === 0,
    suite: "dubzchain-release-candidate-validation",
    version: 1,
    createdAt: now(),
    createdAtIso: new Date().toISOString(),
    config,
    totals,
    endpoints,
    checks,
    recommendation: reportRecommendation(checks),
  };

  fs.writeFileSync(outJson, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(outMd, makeMarkdown(report), "utf8");

  console.log(
    `rc validation complete | ok=${report.ok} | pass=${totals.pass} | warn=${totals.warn} | fail=${totals.fail}`
  );
  console.log(`wrote ${outJson}`);
  console.log(`wrote ${outMd}`);

  if (!report.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exitCode = 1;
});
