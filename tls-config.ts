// tls-config.ts
import * as fs from "fs";
import * as tls from "tls";
import * as crypto from "crypto";

/* =========================
   TLS / Secure WebSocket Support
   Phase 9.13
========================= */

export type P2PTlsMode = "disabled" | "server" | "client" | "mutual";

export type P2PTlsConfig = {
  enabled: boolean;
  mode: P2PTlsMode;

  certFile: string | null;
  keyFile: string | null;
  caFile: string | null;

  certPem: string | null;
  keyPem: string | null;
  caPem: string | null;

  rejectUnauthorized: boolean;
  requestClientCert: boolean;
  allowSelfSignedLocal: boolean;
};

export type P2PTlsStats = {
  enabled: boolean;
  mode: P2PTlsMode;
  scheme: "ws" | "wss";
  certConfigured: boolean;
  keyConfigured: boolean;
  caConfigured: boolean;
  rejectUnauthorized: boolean;
  requestClientCert: boolean;
  allowSelfSignedLocal: boolean;
  certFingerprint256: string | null;
};

function envBool(name: string, fallback = false) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envStr(name: string): string | null {
  const v = String(process.env[name] ?? "").trim();
  return v ? v : null;
}

function readFileMaybe(path: string | null): string | null {
  if (!path) return null;
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function normalizePem(raw: string | null): string | null {
  if (!raw) return null;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function inferMode(enabled: boolean): P2PTlsMode {
  if (!enabled) return "disabled";
  const raw = String(process.env.DUBZ_P2P_TLS_MODE ?? "").trim().toLowerCase();
  if (raw === "server" || raw === "client" || raw === "mutual") return raw;
  return "server";
}

function fingerprintPem(pem: string | null): string | null {
  if (!pem) return null;
  try {
    const cert = new crypto.X509Certificate(pem);
    return cert.fingerprint256;
  } catch {
    return null;
  }
}

export function loadP2PTlsConfig(): P2PTlsConfig {
  const certFile = envStr("DUBZ_P2P_TLS_CERT");
  const keyFile = envStr("DUBZ_P2P_TLS_KEY");
  const caFile = envStr("DUBZ_P2P_TLS_CA");

  const certPem = normalizePem(envStr("DUBZ_P2P_TLS_CERT_PEM")) || readFileMaybe(certFile);
  const keyPem = normalizePem(envStr("DUBZ_P2P_TLS_KEY_PEM")) || readFileMaybe(keyFile);
  const caPem = normalizePem(envStr("DUBZ_P2P_TLS_CA_PEM")) || readFileMaybe(caFile);

  const enabled = envBool("DUBZ_P2P_TLS", false) || (!!certPem && !!keyPem && envBool("DUBZ_P2P_TLS_AUTO", false));

  return {
    enabled,
    mode: inferMode(enabled),

    certFile,
    keyFile,
    caFile,

    certPem,
    keyPem,
    caPem,

    rejectUnauthorized: envBool("DUBZ_P2P_TLS_REJECT_UNAUTHORIZED", false),
    requestClientCert: envBool("DUBZ_P2P_TLS_REQUEST_CLIENT_CERT", false),
    allowSelfSignedLocal: envBool("DUBZ_P2P_TLS_ALLOW_SELF_SIGNED_LOCAL", true),
  };
}

export function buildP2PTlsServerOptions(config: P2PTlsConfig): tls.TlsOptions {
  if (!config.enabled) return {};
  if (!config.certPem || !config.keyPem) {
    throw new Error("P2P TLS enabled but missing DUBZ_P2P_TLS_CERT and/or DUBZ_P2P_TLS_KEY");
  }

  return {
    cert: config.certPem,
    key: config.keyPem,
    ca: config.caPem || undefined,
    requestCert: config.requestClientCert,
    rejectUnauthorized: config.requestClientCert ? config.rejectUnauthorized : false,
  };
}

export function buildP2PTlsClientOptions(config: P2PTlsConfig): tls.ConnectionOptions {
  if (!config.enabled) return {};

  return {
    ca: config.caPem || undefined,
    cert: config.mode === "mutual" ? config.certPem || undefined : undefined,
    key: config.mode === "mutual" ? config.keyPem || undefined : undefined,
    rejectUnauthorized: config.rejectUnauthorized,
  };
}

export function getP2PTlsStats(config: P2PTlsConfig, scheme: "ws" | "wss"): P2PTlsStats {
  return {
    enabled: config.enabled,
    mode: config.mode,
    scheme,
    certConfigured: !!config.certPem,
    keyConfigured: !!config.keyPem,
    caConfigured: !!config.caPem,
    rejectUnauthorized: config.rejectUnauthorized,
    requestClientCert: config.requestClientCert,
    allowSelfSignedLocal: config.allowSelfSignedLocal,
    certFingerprint256: fingerprintPem(config.certPem),
  };
}
