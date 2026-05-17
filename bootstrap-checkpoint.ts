// bootstrap-checkpoint.ts
import * as crypto from "crypto";
import * as fs from "fs";

/* =========================
   Bootstrap Checkpoint Signing
   Phase 9.15
========================= */

export type BootstrapCheckpointSignature = {
  scheme: "RSA-SHA256";
  keyId: string;
  signedAt: number;
  payloadHash: string;
  signature: string;
  signerPublicKey?: string | null;
};

export type BootstrapCheckpointSigningConfig = {
  enabled: boolean;
  requireSignedCheckpoints: boolean;
  includePublicKey: boolean;
  keyId: string | null;
  privateKeyConfigured: boolean;
  publicKeyConfigured: boolean;
  privateKeyFile: string | null;
  publicKeyFile: string | null;
  publicKeyFingerprint256: string | null;
};

export type BootstrapCheckpointSigningStats = BootstrapCheckpointSigningConfig & {
  signedCount: number;
  verifiedCount: number;
  rejectedCount: number;
  unsignedAcceptedCount: number;
  lastSignedAt: number;
  lastVerifiedAt: number;
  lastRejectedAt: number;
  lastRejectReason: string | null;
};

export type BootstrapCheckpointVerifyResult =
  | { ok: true; signed: true; keyId: string; payloadHash: string }
  | { ok: true; signed: false; reason: string }
  | { ok: false; signed: boolean; reason: string };

let signedCount = 0;
let verifiedCount = 0;
let rejectedCount = 0;
let unsignedAcceptedCount = 0;
let lastSignedAt = 0;
let lastVerifiedAt = 0;
let lastRejectedAt = 0;
let lastRejectReason: string | null = null;

function now() {
  return Date.now();
}

function envBool(name: string, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function readMaybeFile(path: string | undefined | null): string | null {
  if (!path) return null;
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function configuredPrivateKey() {
  return process.env.DUBZ_CHECKPOINT_PRIVATE_KEY || readMaybeFile(process.env.DUBZ_CHECKPOINT_PRIVATE_KEY_FILE);
}

function configuredPublicKey() {
  return process.env.DUBZ_CHECKPOINT_PUBLIC_KEY || readMaybeFile(process.env.DUBZ_CHECKPOINT_PUBLIC_KEY_FILE);
}

function sha256Hex(data: string | Buffer) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function stableCanonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "checkpointSignature") continue;
    if (key === "signature") continue;
    out[key] = stableCanonicalize(value[key]);
  }
  return out;
}

function payloadString(payload: any) {
  return JSON.stringify(stableCanonicalize(payload));
}

export function checkpointPayloadHash(payload: any): string {
  return sha256Hex(payloadString(payload));
}

function keyFingerprint(pubKey: string | null): string | null {
  if (!pubKey) return null;
  return sha256Hex(pubKey).slice(0, 32);
}

export function getBootstrapCheckpointSigningConfig(): BootstrapCheckpointSigningConfig {
  const priv = configuredPrivateKey();
  const pub = configuredPublicKey();
  const enabledByKey = !!priv;
  const enabled = envBool("DUBZ_CHECKPOINT_SIGNING", enabledByKey) && enabledByKey;
  const requireSignedCheckpoints = envBool("DUBZ_CHECKPOINT_REQUIRE_SIGNED", false);
  const includePublicKey = envBool("DUBZ_CHECKPOINT_INCLUDE_PUBLIC_KEY", false);
  const keyId = process.env.DUBZ_CHECKPOINT_KEY_ID || keyFingerprint(pub) || keyFingerprint(priv);

  return {
    enabled,
    requireSignedCheckpoints,
    includePublicKey,
    keyId,
    privateKeyConfigured: !!priv,
    publicKeyConfigured: !!pub,
    privateKeyFile: process.env.DUBZ_CHECKPOINT_PRIVATE_KEY_FILE || null,
    publicKeyFile: process.env.DUBZ_CHECKPOINT_PUBLIC_KEY_FILE || null,
    publicKeyFingerprint256: keyFingerprint(pub),
  };
}

export function getBootstrapCheckpointSigningStats(): BootstrapCheckpointSigningStats {
  return {
    ...getBootstrapCheckpointSigningConfig(),
    signedCount,
    verifiedCount,
    rejectedCount,
    unsignedAcceptedCount,
    lastSignedAt,
    lastVerifiedAt,
    lastRejectedAt,
    lastRejectReason,
  };
}

export function signBootstrapCheckpoint<T extends Record<string, any>>(payload: T): T {
  const cfg = getBootstrapCheckpointSigningConfig();
  if (!cfg.enabled) return payload;

  const privateKey = configuredPrivateKey();
  if (!privateKey) return payload;

  const canonical = payloadString(payload);
  const payloadHash = sha256Hex(canonical);
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(canonical);
  sign.end();

  const signature: BootstrapCheckpointSignature = {
    scheme: "RSA-SHA256",
    keyId: cfg.keyId || "unknown",
    signedAt: now(),
    payloadHash,
    signature: sign.sign(privateKey).toString("base64"),
    signerPublicKey: cfg.includePublicKey ? configuredPublicKey() : null,
  };

  signedCount++;
  lastSignedAt = signature.signedAt;

  return {
    ...payload,
    checkpointSignature: signature,
  };
}

export function verifyBootstrapCheckpointSignature(payload: any): BootstrapCheckpointVerifyResult {
  const cfg = getBootstrapCheckpointSigningConfig();
  const sig = payload?.checkpointSignature as BootstrapCheckpointSignature | undefined;

  if (!sig) {
    if (cfg.requireSignedCheckpoints) {
      rejectedCount++;
      lastRejectedAt = now();
      lastRejectReason = "missing-checkpoint-signature";
      return { ok: false, signed: false, reason: "missing-checkpoint-signature" };
    }

    unsignedAcceptedCount++;
    return { ok: true, signed: false, reason: "unsigned-accepted" };
  }

  if (!sig || typeof sig !== "object") {
    rejectedCount++;
    lastRejectedAt = now();
    lastRejectReason = "bad-checkpoint-signature-shape";
    return { ok: false, signed: true, reason: "bad-checkpoint-signature-shape" };
  }

  if (sig.scheme !== "RSA-SHA256") {
    rejectedCount++;
    lastRejectedAt = now();
    lastRejectReason = "unsupported-checkpoint-signature-scheme";
    return { ok: false, signed: true, reason: "unsupported-checkpoint-signature-scheme" };
  }

  if (typeof sig.signature !== "string" || !sig.signature) {
    rejectedCount++;
    lastRejectedAt = now();
    lastRejectReason = "missing-signature-bytes";
    return { ok: false, signed: true, reason: "missing-signature-bytes" };
  }

  const payloadHash = checkpointPayloadHash(payload);
  if (sig.payloadHash !== payloadHash) {
    rejectedCount++;
    lastRejectedAt = now();
    lastRejectReason = "checkpoint-payload-hash-mismatch";
    return { ok: false, signed: true, reason: "checkpoint-payload-hash-mismatch" };
  }

  const publicKey = configuredPublicKey() || sig.signerPublicKey || null;
  if (!publicKey) {
    if (cfg.requireSignedCheckpoints) {
      rejectedCount++;
      lastRejectedAt = now();
      lastRejectReason = "missing-checkpoint-public-key";
      return { ok: false, signed: true, reason: "missing-checkpoint-public-key" };
    }

    unsignedAcceptedCount++;
    return { ok: true, signed: false, reason: "signed-but-no-public-key-configured" };
  }

  try {
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(payloadString(payload));
    verifier.end();
    const ok = verifier.verify(publicKey, Buffer.from(sig.signature, "base64"));

    if (!ok) {
      rejectedCount++;
      lastRejectedAt = now();
      lastRejectReason = "checkpoint-signature-verify-failed";
      return { ok: false, signed: true, reason: "checkpoint-signature-verify-failed" };
    }

    verifiedCount++;
    lastVerifiedAt = now();
    return { ok: true, signed: true, keyId: sig.keyId, payloadHash };
  } catch (e: any) {
    rejectedCount++;
    lastRejectedAt = now();
    lastRejectReason = e?.message || String(e);
    return { ok: false, signed: true, reason: lastRejectReason || "verify-error" };
  }
}
