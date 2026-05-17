// explorer-deploy.ts
import * as http from "http";
import { URL } from "url";

/* =========================
   Public Explorer Deployment Prep
   Phase 9.16
========================= */

export type ExplorerDeploymentMode = "local" | "public";

export type ExplorerDeploymentConfig = {
  enabled: boolean;
  mode: ExplorerDeploymentMode;
  publicUrl: string | null;
  environment: string;
  behindProxy: boolean;
  trustProxy: boolean;
  corsEnabled: boolean;
  corsOrigins: string[];
  corsAllowOriginHeader: string | null;
  frameAncestors: string;
  robotsPolicy: string;
  cacheSeconds: number;
  securityHeadersEnabled: boolean;
  deploymentId: string;
  generatedAt: number;
};

export type ExplorerDeploymentStats = ExplorerDeploymentConfig & {
  publicReady: boolean;
  warnings: string[];
  headers: Record<string, string>;
};

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || Math.floor(n) !== n) return fallback;
  return n;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function safeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function makeDeploymentId() {
  return `explorer_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

const deploymentConfig: ExplorerDeploymentConfig = createExplorerDeploymentConfig();

export function createExplorerDeploymentConfig(): ExplorerDeploymentConfig {
  const publicUrl = safeUrl(process.env.DUBZ_EXPLORER_PUBLIC_URL);
  const publicMode = envBool("DUBZ_EXPLORER_PUBLIC", false) || !!publicUrl;
  const corsOrigins = splitList(process.env.DUBZ_EXPLORER_CORS_ORIGINS);
  const corsEnabled = envBool("DUBZ_EXPLORER_CORS", publicMode || corsOrigins.length > 0);
  const allowAllCors = corsOrigins.includes("*");
  const cacheSeconds = Math.max(0, envInt("DUBZ_EXPLORER_CACHE_SECONDS", publicMode ? 15 : 0));

  return {
    enabled: true,
    mode: publicMode ? "public" : "local",
    publicUrl,
    environment: process.env.DUBZ_EXPLORER_ENV || (publicMode ? "production" : "local"),
    behindProxy: envBool("DUBZ_EXPLORER_BEHIND_PROXY", false),
    trustProxy: envBool("DUBZ_EXPLORER_TRUST_PROXY", false),
    corsEnabled,
    corsOrigins,
    corsAllowOriginHeader: corsEnabled ? (allowAllCors ? "*" : corsOrigins[0] || publicUrl) : null,
    frameAncestors: process.env.DUBZ_EXPLORER_FRAME_ANCESTORS || (publicMode ? "'none'" : "'self'"),
    robotsPolicy: process.env.DUBZ_EXPLORER_ROBOTS || (publicMode ? "index,follow" : "noindex,nofollow"),
    cacheSeconds,
    securityHeadersEnabled: envBool("DUBZ_EXPLORER_SECURITY_HEADERS", true),
    deploymentId: process.env.DUBZ_EXPLORER_DEPLOYMENT_ID || makeDeploymentId(),
    generatedAt: Date.now(),
  };
}

export function getExplorerDeploymentConfig(): ExplorerDeploymentConfig {
  return deploymentConfig;
}

export function explorerDeploymentHeaders(config: ExplorerDeploymentConfig = deploymentConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "x-dubz-explorer-mode": config.mode,
    "x-dubz-explorer-deployment-id": config.deploymentId,
    "x-content-type-options": "nosniff",
  };

  headers["cache-control"] = config.cacheSeconds > 0 ? `public, max-age=${config.cacheSeconds}` : "no-store";

  if (config.securityHeadersEnabled) {
    headers["referrer-policy"] = "no-referrer";
    headers["x-frame-options"] = config.frameAncestors === "'none'" ? "DENY" : "SAMEORIGIN";
    headers["permissions-policy"] = "camera=(), microphone=(), geolocation=(), payment=()";
    headers["content-security-policy"] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' http: https: ws: wss:",
      `frame-ancestors ${config.frameAncestors}`,
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
  }

  if (config.corsEnabled && config.corsAllowOriginHeader) {
    headers["access-control-allow-origin"] = config.corsAllowOriginHeader;
    headers["access-control-allow-methods"] = "GET,POST,OPTIONS";
    headers["access-control-allow-headers"] = "content-type,authorization,x-api-key";
    headers["access-control-max-age"] = "600";
  }

  return headers;
}

export function writeExplorerHeaders(
  res: http.ServerResponse,
  extra: Record<string, string | number> = {},
  config: ExplorerDeploymentConfig = deploymentConfig
) {
  const headers = explorerDeploymentHeaders(config);
  for (const [k, v] of Object.entries({ ...headers, ...extra })) {
    res.setHeader(k, v);
  }
}

export function handleExplorerOptions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ExplorerDeploymentConfig = deploymentConfig
): boolean {
  if ((req.method || "GET").toUpperCase() !== "OPTIONS") return false;
  writeExplorerHeaders(res, { "content-length": 0 }, config);
  res.statusCode = 204;
  res.end();
  return true;
}

export function robotsTxt(config: ExplorerDeploymentConfig = deploymentConfig): string {
  const allow = config.robotsPolicy.toLowerCase().includes("index") && !config.robotsPolicy.toLowerCase().includes("noindex");
  return [
    "User-agent: *",
    allow ? "Allow: /" : "Disallow: /",
    `# DubzChain explorer mode: ${config.mode}`,
    config.publicUrl ? `# Public URL: ${config.publicUrl}` : "# Public URL: not configured",
    "",
  ].join("\n");
}

export function getExplorerDeploymentStats(
  config: ExplorerDeploymentConfig = deploymentConfig
): ExplorerDeploymentStats {
  const warnings: string[] = [];

  if (config.mode === "public" && !config.publicUrl) {
    warnings.push("DUBZ_EXPLORER_PUBLIC is enabled but DUBZ_EXPLORER_PUBLIC_URL is not set.");
  }
  if (config.mode === "public" && !config.securityHeadersEnabled) {
    warnings.push("Security headers are disabled for a public explorer.");
  }
  if (config.mode === "public" && !config.corsEnabled) {
    warnings.push("CORS is disabled for a public explorer.");
  }
  if (config.corsAllowOriginHeader === "*") {
    warnings.push("CORS allows every origin. Use a specific DUBZ_EXPLORER_CORS_ORIGINS value for production.");
  }

  return {
    ...config,
    publicReady: config.mode === "public" ? warnings.length === 0 : true,
    warnings,
    headers: explorerDeploymentHeaders(config),
  };
}
