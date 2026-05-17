// chainstate.ts
import * as fs from "fs";
import * as pathMod from "path";

/* =========================
   Chainstate Database Separation
   Phase 9.7
========================= */

export type ChainstatePendingReward = {
  amount: number;
  unlockHeight: number;
};

export type ChainstateJson = {
  version: number;
  chainId: string;
  protocolVersion: number;

  height: number;
  tipHash: string;
  stateRoot: string;

  minted: number;
  balances: Record<string, number>;
  nonces: Record<string, number>;
  pending: Record<string, ChainstatePendingReward[]>;

  createdAt: number;
  updatedAt: number;
};

export type ChainstateLoadResult =
  | {
      ok: true;
      file: string;
      loadedFrom: "primary" | "backup";
      data: ChainstateJson;
    }
  | {
      ok: false;
      file: string;
      reason: "missing" | "parse-error" | "shape-error" | "read-error";
      error?: string;
    };

export type ChainstateSaveResult =
  | {
      ok: true;
      file: string;
      backupFile: string;
      bytes: number;
      savedAt: number;
    }
  | {
      ok: false;
      file: string;
      backupFile: string;
      reason: "write-error";
      error: string;
    };

export type ChainstateStats = {
  file: string;
  backupFile: string;
  exists: boolean;
  backupExists: boolean;
  bytes: number;
  backupBytes: number;
  height: number | null;
  tipHash: string | null;
  stateRoot: string | null;
  minted: number | null;
  balancesCount: number;
  noncesCount: number;
  pendingAccounts: number;
  pendingRewards: number;
  updatedAt: number | null;
};

const CHAINSTATE_VERSION = 1;

function now() {
  return Date.now();
}

function isSafeInt(n: any) {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}

function isObj(x: any) {
  return !!x && typeof x === "object" && !Array.isArray(x);
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

function writeTextAtomic(filePath: string, text: string) {
  const dir = pathMod.dirname(filePath) || ".";
  const base = pathMod.basename(filePath);
  const tmp = pathMod.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  let fd: number | null = null;

  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmp, filePath);
    fsyncDirBestEffort(filePath);
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

function safeFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function countPendingRewards(pending: Record<string, ChainstatePendingReward[]>) {
  let n = 0;
  for (const arr of Object.values(pending || {})) {
    if (Array.isArray(arr)) n += arr.length;
  }
  return n;
}

function cleanNumberRecord(raw: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;

  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || !k) continue;
    if (!isSafeInt(v) || (v as number) < 0) continue;
    out[k] = v as number;
  }

  return out;
}

function cleanPendingRecord(raw: any): Record<string, ChainstatePendingReward[]> {
  const out: Record<string, ChainstatePendingReward[]> = {};
  if (!isObj(raw)) return out;

  for (const [addr, arr] of Object.entries(raw)) {
    if (typeof addr !== "string" || !addr) continue;
    if (!Array.isArray(arr)) continue;

    const clean: ChainstatePendingReward[] = [];

    for (const item of arr) {
      if (!isObj(item)) continue;
      const amount = (item as any).amount;
      const unlockHeight = (item as any).unlockHeight;

      if (!isSafeInt(amount) || amount < 0) continue;
      if (!isSafeInt(unlockHeight) || unlockHeight < 0) continue;

      clean.push({ amount, unlockHeight });
    }

    if (clean.length > 0) {
      clean.sort((a, b) => a.unlockHeight - b.unlockHeight || a.amount - b.amount);
      out[addr] = clean;
    }
  }

  return out;
}

function validateChainstateShape(raw: any): raw is ChainstateJson {
  if (!isObj(raw)) return false;

  if (raw.version !== CHAINSTATE_VERSION) return false;
  if (typeof raw.chainId !== "string" || !raw.chainId) return false;
  if (!isSafeInt(raw.protocolVersion) || raw.protocolVersion <= 0) return false;

  if (!isSafeInt(raw.height) || raw.height < 0) return false;
  if (typeof raw.tipHash !== "string" || !raw.tipHash) return false;
  if (typeof raw.stateRoot !== "string" || !raw.stateRoot) return false;

  if (!isSafeInt(raw.minted) || raw.minted < 0) return false;
  if (!isObj(raw.balances)) return false;
  if (!isObj(raw.nonces)) return false;
  if (!isObj(raw.pending)) return false;

  if (!isSafeInt(raw.createdAt) || raw.createdAt <= 0) return false;
  if (!isSafeInt(raw.updatedAt) || raw.updatedAt <= 0) return false;

  return true;
}

function normalizeChainstate(raw: ChainstateJson): ChainstateJson {
  return {
    version: CHAINSTATE_VERSION,
    chainId: raw.chainId,
    protocolVersion: raw.protocolVersion,

    height: raw.height,
    tipHash: raw.tipHash,
    stateRoot: raw.stateRoot,

    minted: raw.minted,
    balances: cleanNumberRecord(raw.balances),
    nonces: cleanNumberRecord(raw.nonces),
    pending: cleanPendingRecord(raw.pending),

    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export function chainstateFileFor(chainFile: string) {
  return chainFile.replace(/\.json$/, "") + ".chainstate.json";
}

export function chainstateBackupFileFor(chainFile: string) {
  return chainstateFileFor(chainFile) + ".bak";
}

export function makeChainstateJson(args: {
  chainId: string;
  protocolVersion: number;
  height: number;
  tipHash: string;
  stateRoot: string;
  minted: number;
  balances: Record<string, number>;
  nonces: Record<string, number>;
  pending: Record<string, ChainstatePendingReward[]>;
  previousCreatedAt?: number;
}): ChainstateJson {
  const ts = now();

  return {
    version: CHAINSTATE_VERSION,
    chainId: args.chainId,
    protocolVersion: args.protocolVersion,

    height: args.height,
    tipHash: args.tipHash,
    stateRoot: args.stateRoot,

    minted: args.minted,
    balances: cleanNumberRecord(args.balances),
    nonces: cleanNumberRecord(args.nonces),
    pending: cleanPendingRecord(args.pending),

    createdAt: args.previousCreatedAt && args.previousCreatedAt > 0 ? args.previousCreatedAt : ts,
    updatedAt: ts,
  };
}

export function loadChainstate(chainFile: string): ChainstateLoadResult {
  const file = chainstateFileFor(chainFile);
  const backupFile = chainstateBackupFileFor(chainFile);

  const tryLoad = (filePath: string, loadedFrom: "primary" | "backup"): ChainstateLoadResult => {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      let parsed: any;

      try {
        parsed = JSON.parse(text);
      } catch (e: any) {
        return {
          ok: false,
          file: filePath,
          reason: "parse-error",
          error: e?.message ?? String(e),
        };
      }

      if (!validateChainstateShape(parsed)) {
        return {
          ok: false,
          file: filePath,
          reason: "shape-error",
        };
      }

      return {
        ok: true,
        file: filePath,
        loadedFrom,
        data: normalizeChainstate(parsed),
      };
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        return {
          ok: false,
          file: filePath,
          reason: "missing",
        };
      }

      return {
        ok: false,
        file: filePath,
        reason: "read-error",
        error: e?.message ?? String(e),
      };
    }
  };

  const primary = tryLoad(file, "primary");
  if (primary.ok) return primary;

  const backup = tryLoad(backupFile, "backup");
  if (backup.ok) {
    try {
      saveChainstate(chainFile, backup.data);
    } catch {}
    return backup;
  }

  return primary;
}

export function saveChainstate(chainFile: string, data: ChainstateJson): ChainstateSaveResult {
  const file = chainstateFileFor(chainFile);
  const backupFile = chainstateBackupFileFor(chainFile);

  try {
    const normalized = normalizeChainstate(data);
    const text = JSON.stringify(normalized, null, 2);

    writeTextAtomic(file, text);

    try {
      copyFileAtomic(file, backupFile);
    } catch {}

    return {
      ok: true,
      file,
      backupFile,
      bytes: Buffer.byteLength(text, "utf8"),
      savedAt: now(),
    };
  } catch (e: any) {
    return {
      ok: false,
      file,
      backupFile,
      reason: "write-error",
      error: e?.message ?? String(e),
    };
  }
}

export function deleteChainstate(chainFile: string): boolean {
  const file = chainstateFileFor(chainFile);
  const backupFile = chainstateBackupFileFor(chainFile);

  let ok = true;

  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    ok = false;
  }

  try {
    if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
  } catch {
    ok = false;
  }

  return ok;
}

export function getChainstateStats(chainFile: string): ChainstateStats {
  const file = chainstateFileFor(chainFile);
  const backupFile = chainstateBackupFileFor(chainFile);

  const loaded = loadChainstate(chainFile);

  if (!loaded.ok) {
    return {
      file,
      backupFile,
      exists: fs.existsSync(file),
      backupExists: fs.existsSync(backupFile),
      bytes: safeFileSize(file),
      backupBytes: safeFileSize(backupFile),
      height: null,
      tipHash: null,
      stateRoot: null,
      minted: null,
      balancesCount: 0,
      noncesCount: 0,
      pendingAccounts: 0,
      pendingRewards: 0,
      updatedAt: null,
    };
  }

  const data = loaded.data;

  return {
    file,
    backupFile,
    exists: fs.existsSync(file),
    backupExists: fs.existsSync(backupFile),
    bytes: safeFileSize(file),
    backupBytes: safeFileSize(backupFile),
    height: data.height,
    tipHash: data.tipHash,
    stateRoot: data.stateRoot,
    minted: data.minted,
    balancesCount: Object.keys(data.balances).length,
    noncesCount: Object.keys(data.nonces).length,
    pendingAccounts: Object.keys(data.pending).length,
    pendingRewards: countPendingRewards(data.pending),
    updatedAt: data.updatedAt,
  };
}

export function chainstateToMaps(data: ChainstateJson): {
  balances: Map<string, number>;
  nonces: Map<string, number>;
  pending: Map<string, ChainstatePendingReward[]>;
  minted: number;
} {
  const balances = new Map<string, number>();
  const nonces = new Map<string, number>();
  const pending = new Map<string, ChainstatePendingReward[]>();

  for (const [k, v] of Object.entries(data.balances)) {
    balances.set(k, v);
  }

  for (const [k, v] of Object.entries(data.nonces)) {
    nonces.set(k, v);
  }

  for (const [k, arr] of Object.entries(data.pending)) {
    pending.set(
      k,
      arr.map((x) => ({
        amount: x.amount,
        unlockHeight: x.unlockHeight,
      }))
    );
  }

  return {
    balances,
    nonces,
    pending,
    minted: data.minted,
  };
}

export function mapsToChainstateRecords(args: {
  balances: Map<string, number>;
  nonces: Map<string, number>;
  pending: Map<string, ChainstatePendingReward[]>;
}): {
  balances: Record<string, number>;
  nonces: Record<string, number>;
  pending: Record<string, ChainstatePendingReward[]>;
} {
  const balances: Record<string, number> = {};
  const nonces: Record<string, number> = {};
  const pending: Record<string, ChainstatePendingReward[]> = {};

  for (const [k, v] of args.balances.entries()) {
    balances[k] = v;
  }

  for (const [k, v] of args.nonces.entries()) {
    nonces[k] = v;
  }

  for (const [k, arr] of args.pending.entries()) {
    pending[k] = arr.map((x) => ({
      amount: x.amount,
      unlockHeight: x.unlockHeight,
    }));
  }

  return {
    balances,
    nonces,
    pending,
  };
}