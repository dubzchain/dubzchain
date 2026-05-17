// rpc-auth.ts
import * as crypto from "crypto";
import * as http from "http";

/* =========================
   RPC Auth / API Keys
   Phase 9.12
========================= */

export type RpcAuthMode = "disabled" | "api-key";

export type RpcAuthDecision = {
  ok: boolean;
  required: boolean;
  mode: RpcAuthMode;
  reason?: string;
  keyId?: string | null;
};

export type RpcAuthConfig = {
  enabled: boolean;
  requireWriteAuth: boolean;
  requireDebugAuth: boolean;
  allowLocalhostWithoutKey: boolean;
  keys: Map<string, string>;
  publicPaths: Set<string>;
};

export type RpcAuthStats = {
  enabled: boolean;
  mode: RpcAuthMode;
  requireWriteAuth: boolean;
  requireDebugAuth: boolean;
  allowLocalhostWithoutKey: boolean;
  keyCount: number;
  allowed: number;
  rejected: number;
  publicAllowed: number;
  localhostAllowed: number;
  lastRejectAt: number;
  lastRejectReason: string | null;
  lastAcceptedKeyId: string | null;
};

const DEFAULT_PUBLIC_PATHS = new Set<string>([
  "/",
  "/health",
  "/status",
  "/diagnostics",
  "/diag",
  "/diagnostics/network",
  "/network",
  "/peers",
  "/sync",
  "/storage",
  "/metrics",
  "/height",
  "/tip",
  "/mempool",
  "/block",
  "/headers",
  "/stats",
  "/index",
  "/snapshot/meta",
]);

let allowed = 0;
let rejected = 0;
let publicAllowed = 0;
let localhostAllowed = 0;
let lastRejectAt = 0;
let lastRejectReason: string | null = null;
let lastAcceptedKeyId: string | null = null;
let lastConfig: RpcAuthConfig | null = null;

function now() {
  return Date.now();
}

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseApiKeys(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;

  const parts = raw
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  let idx = 1;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const keyId = part.slice(0, eq).trim();
      const key = part.slice(eq + 1).trim();
      if (keyId && key) out.set(keyId, key);
      continue;
    }

    out.set(`key${idx++}`, part);
  }

  return out;
}

function timingSafeEqualString(a: string, b: string) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function remoteIp(req: http.IncomingMessage) {
  const raw = req.socket.remoteAddress || "";
  if (raw === "::1") return "127.0.0.1";
  if (raw === "::ffff:127.0.0.1") return "127.0.0.1";
  return raw;
}

function isLocalhost(req: http.IncomingMessage) {
  const ip = remoteIp(req);
  return ip === "127.0.0.1" || ip === "localhost";
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string") return value;
  return null;
}

function extractBearer(req: http.IncomingMessage): string | null {
  const auth = headerValue(req, "authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function extractApiKey(req: http.IncomingMessage): string | null {
  return headerValue(req, "x-api-key") || extractBearer(req);
}

function pathIsPublic(path: string, method: string, cfg: RpcAuthConfig) {
  if (method !== "GET") return false;
  return cfg.publicPaths.has(path);
}

function pathIsDebug(path: string) {
  return path.startsWith("/debug") || path.startsWith("/proof/verify");
}

function pathIsWrite(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function createRpcAuthConfig(extraPublicPaths: string[] = []): RpcAuthConfig {
  const keys = parseApiKeys(process.env.DUBZ_RPC_API_KEYS || process.env.DUBZ_RPC_API_KEY);
  const explicitEnabled = boolEnv("DUBZ_RPC_AUTH", keys.size > 0);
  const publicPaths = new Set(DEFAULT_PUBLIC_PATHS);
  for (const p of extraPublicPaths) publicPaths.add(p);

  const cfg: RpcAuthConfig = {
    enabled: explicitEnabled && keys.size > 0,
    requireWriteAuth: boolEnv("DUBZ_RPC_AUTH_WRITE", true),
    requireDebugAuth: boolEnv("DUBZ_RPC_AUTH_DEBUG", true),
    allowLocalhostWithoutKey: boolEnv("DUBZ_RPC_AUTH_LOCALHOST_BYPASS", true),
    keys,
    publicPaths,
  };

  lastConfig = cfg;
  return cfg;
}

export function checkRpcAuth(
  req: http.IncomingMessage,
  method: string,
  path: string,
  cfg: RpcAuthConfig
): RpcAuthDecision {
  if (!cfg.enabled) {
    allowed++;
    return { ok: true, required: false, mode: "disabled", reason: "auth-disabled" };
  }

  if (pathIsPublic(path, method, cfg)) {
    allowed++;
    publicAllowed++;
    return { ok: true, required: false, mode: "api-key", reason: "public-path" };
  }

  const needsWrite = cfg.requireWriteAuth && pathIsWrite(method);
  const needsDebug = cfg.requireDebugAuth && pathIsDebug(path);
  const required = needsWrite || needsDebug;

  if (!required) {
    allowed++;
    return { ok: true, required: false, mode: "api-key", reason: "auth-not-required" };
  }

  if (cfg.allowLocalhostWithoutKey && isLocalhost(req)) {
    allowed++;
    localhostAllowed++;
    return { ok: true, required: false, mode: "api-key", reason: "localhost-bypass" };
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    rejected++;
    lastRejectAt = now();
    lastRejectReason = "missing-api-key";
    return { ok: false, required: true, mode: "api-key", reason: "missing-api-key" };
  }

  for (const [keyId, key] of cfg.keys.entries()) {
    if (timingSafeEqualString(apiKey, key)) {
      allowed++;
      lastAcceptedKeyId = keyId;
      return { ok: true, required: true, mode: "api-key", keyId, reason: "api-key-ok" };
    }
  }

  rejected++;
  lastRejectAt = now();
  lastRejectReason = "bad-api-key";
  return { ok: false, required: true, mode: "api-key", reason: "bad-api-key" };
}

export function rpcAuthHeaders() {
  return {
    "www-authenticate": 'Bearer realm="DubzChain RPC"',
  };
}

export function getRpcAuthStats(): RpcAuthStats {
  const cfg = lastConfig;
  return {
    enabled: !!cfg?.enabled,
    mode: cfg?.enabled ? "api-key" : "disabled",
    requireWriteAuth: cfg?.requireWriteAuth ?? true,
    requireDebugAuth: cfg?.requireDebugAuth ?? true,
    allowLocalhostWithoutKey: cfg?.allowLocalhostWithoutKey ?? true,
    keyCount: cfg?.keys.size ?? 0,
    allowed,
    rejected,
    publicAllowed,
    localhostAllowed,
    lastRejectAt,
    lastRejectReason,
    lastAcceptedKeyId,
  };
}
