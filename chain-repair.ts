// chain-repair.ts
import * as fs from "fs";
import * as pathMod from "path";
import { chainstateFileFor, chainstateBackupFileFor } from "./chainstate";
import { crashJournalFileFor, crashJournalBackupFileFor } from "./crash-journal";

/* =========================
   Chain Corruption Auto-Repair
   Phase 9.10
========================= */

export type ChainRepairTarget =
  | "chain"
  | "chain-backup"
  | "snapshot"
  | "snapshot-backup"
  | "chainstate"
  | "chainstate-backup"
  | "crash-journal"
  | "crash-journal-backup";

export type ChainRepairAction =
  | "none"
  | "restored-from-backup"
  | "backup-created"
  | "quarantined-corrupt"
  | "deleted-temp"
  | "missing"
  | "valid"
  | "invalid";

export type ChainRepairItem = {
  target: ChainRepairTarget;
  file: string;
  backupFile: string | null;
  exists: boolean;
  bytes: number;
  validJson: boolean;
  validShape: boolean;
  action: ChainRepairAction;
  reason: string | null;
  quarantineFile: string | null;
  repairedAt: number | null;
};

export type ChainRepairResult = {
  ok: boolean;
  chainFile: string;
  repaired: boolean;
  checkedAt: number;
  items: ChainRepairItem[];
  errors: string[];
};

export type ChainRepairStats = {
  checkedAt: number;
  chainFile: string;
  lastOk: boolean;
  lastRepaired: boolean;
  lastErrors: string[];
  totalChecks: number;
  totalRepairs: number;
  totalQuarantined: number;
  totalRestoreFromBackup: number;
  lastItems: ChainRepairItem[];
};

const repairStatsByChainFile = new Map<string, ChainRepairStats>();

function now() {
  return Date.now();
}

function isObj(x: any) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function safeSize(file: string) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function backupFileFor(filePath: string) {
  return `${filePath}.bak`;
}

function snapshotFileFor(chainFile: string) {
  return chainFile.replace(/\.json$/, "") + `.snapshot.json`;
}

function snapshotBackupFileFor(chainFile: string) {
  return backupFileFor(snapshotFileFor(chainFile));
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

function copyFileAtomic(srcPath: string, dstPath: string) {
  const dir = pathMod.dirname(dstPath) || ".";
  const base = pathMod.basename(dstPath);
  const tmp = pathMod.join(
    dir,
    `.${base}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );

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

function quarantineFile(filePath: string, tag = "corrupt"): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const dir = pathMod.dirname(filePath) || ".";
    const base = pathMod.basename(filePath);
    const out = pathMod.join(dir, `${base}.${tag}.${Date.now()}`);
    fs.renameSync(filePath, out);
    fsyncDirBestEffort(out);
    return out;
  } catch {
    return null;
  }
}

function readJson(filePath: string): { ok: boolean; parsed: any | null; reason?: string } {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    try {
      return { ok: true, parsed: JSON.parse(text) };
    } catch (e: any) {
      return { ok: false, parsed: null, reason: `parse-error:${e?.message ?? String(e)}` };
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: false, parsed: null, reason: "missing" };
    return { ok: false, parsed: null, reason: `read-error:${e?.message ?? String(e)}` };
  }
}

function chainShapeValid(x: any): boolean {
  if (!isObj(x)) return false;
  if (!Array.isArray(x.blocks) || x.blocks.length === 0) return false;
  for (const b of x.blocks) {
    if (!isObj(b)) return false;
    if (typeof b.hash !== "string") return false;
    if (typeof b.prevHash !== "string") return false;
    if (typeof b.ts !== "number") return false;
    if (typeof b.nonce !== "number") return false;
    if (typeof b.difficulty !== "number") return false;
    if (typeof b.stateRoot !== "string") return false;
    if (!Array.isArray(b.txs)) return false;
  }
  if (x.mempool !== undefined && !Array.isArray(x.mempool)) return false;
  return true;
}

function snapshotShapeValid(x: any): boolean {
  if (!isObj(x)) return false;
  if (typeof x.height !== "number" || x.height < 0) return false;
  if (typeof x.tipHash !== "string" || !x.tipHash) return false;
  if (typeof x.minted !== "number" || x.minted < 0) return false;
  if (!isObj(x.balances)) return false;
  if (!isObj(x.nonces)) return false;
  if (!isObj(x.pending)) return false;
  return true;
}

function chainstateShapeValid(x: any): boolean {
  if (!isObj(x)) return false;
  if (x.version !== 1) return false;
  if (typeof x.chainId !== "string" || !x.chainId) return false;
  if (typeof x.protocolVersion !== "number" || x.protocolVersion <= 0) return false;
  if (typeof x.height !== "number" || x.height < 0) return false;
  if (typeof x.tipHash !== "string" || !x.tipHash) return false;
  if (typeof x.stateRoot !== "string" || !x.stateRoot) return false;
  if (typeof x.minted !== "number" || x.minted < 0) return false;
  if (!isObj(x.balances)) return false;
  if (!isObj(x.nonces)) return false;
  if (!isObj(x.pending)) return false;
  return true;
}

function journalShapeValid(x: any): boolean {
  if (!isObj(x)) return false;
  if (x.version !== 1) return false;
  if (typeof x.id !== "string" || !x.id) return false;
  if (typeof x.chainFile !== "string" || !x.chainFile) return false;
  if (typeof x.operation !== "string" || !x.operation) return false;
  if (typeof x.status !== "string" || !x.status) return false;
  if (typeof x.stage !== "string" || !x.stage) return false;
  return true;
}

function checkItem(args: {
  target: ChainRepairTarget;
  file: string;
  backupFile: string | null;
  shape: (x: any) => boolean;
}): ChainRepairItem {
  const exists = fs.existsSync(args.file);
  const size = safeSize(args.file);
  const read = exists ? readJson(args.file) : { ok: false, parsed: null, reason: "missing" };
  const validJson = !!read.ok;
  const validShape = validJson ? args.shape(read.parsed) : false;

  return {
    target: args.target,
    file: args.file,
    backupFile: args.backupFile,
    exists,
    bytes: size,
    validJson,
    validShape,
    action: validShape ? "valid" : exists ? "invalid" : "missing",
    reason: validShape ? null : read.reason ?? "shape-error",
    quarantineFile: null,
    repairedAt: null,
  };
}

function tryRepairPair(args: {
  target: ChainRepairTarget;
  file: string;
  backupFile: string;
  shape: (x: any) => boolean;
}): ChainRepairItem[] {
  const ts = now();
  const primary = checkItem(args);
  const backup = checkItem({
    target: `${args.target}-backup` as ChainRepairTarget,
    file: args.backupFile,
    backupFile: null,
    shape: args.shape,
  });

  if (primary.validShape) {
    if (!backup.exists || !backup.validShape) {
      try {
        copyFileAtomic(args.file, args.backupFile);
        backup.action = "backup-created";
        backup.repairedAt = ts;
        backup.exists = true;
        backup.bytes = safeSize(args.backupFile);
        backup.validJson = true;
        backup.validShape = true;
        backup.reason = "backup refreshed from valid primary";
      } catch (e: any) {
        backup.reason = `backup-create-failed:${e?.message ?? String(e)}`;
      }
    }

    return [primary, backup];
  }

  if (backup.validShape) {
    if (primary.exists) {
      primary.quarantineFile = quarantineFile(args.file, "corrupt");
      primary.action = "quarantined-corrupt";
      primary.repairedAt = ts;
    }

    try {
      copyFileAtomic(args.backupFile, args.file);
      primary.action = "restored-from-backup";
      primary.repairedAt = ts;
      primary.exists = true;
      primary.bytes = safeSize(args.file);
      primary.validJson = true;
      primary.validShape = true;
      primary.reason = "restored from valid backup";
    } catch (e: any) {
      primary.reason = `restore-failed:${e?.message ?? String(e)}`;
    }

    return [primary, backup];
  }

  if (primary.exists) {
    primary.quarantineFile = quarantineFile(args.file, "corrupt");
    if (primary.quarantineFile) {
      primary.action = "quarantined-corrupt";
      primary.repairedAt = ts;
    }
  }

  if (backup.exists) {
    backup.quarantineFile = quarantineFile(args.backupFile, "corrupt");
    if (backup.quarantineFile) {
      backup.action = "quarantined-corrupt";
      backup.repairedAt = ts;
    }
  }

  return [primary, backup];
}

export function recoverChainFiles(chainFile: string): ChainRepairResult {
  const checkedAt = now();
  const items: ChainRepairItem[] = [];
  const errors: string[] = [];

  const pairs = [
    {
      target: "chain" as const,
      file: chainFile,
      backupFile: backupFileFor(chainFile),
      shape: chainShapeValid,
    },
    {
      target: "snapshot" as const,
      file: snapshotFileFor(chainFile),
      backupFile: snapshotBackupFileFor(chainFile),
      shape: snapshotShapeValid,
    },
    {
      target: "chainstate" as const,
      file: chainstateFileFor(chainFile),
      backupFile: chainstateBackupFileFor(chainFile),
      shape: chainstateShapeValid,
    },
    {
      target: "crash-journal" as const,
      file: crashJournalFileFor(chainFile),
      backupFile: crashJournalBackupFileFor(chainFile),
      shape: journalShapeValid,
    },
  ];

  for (const pair of pairs) {
    const repairedItems = tryRepairPair(pair);
    items.push(...repairedItems);
  }

  for (const item of items) {
    if (item.action === "invalid" || item.action === "quarantined-corrupt") {
      errors.push(`${item.target}:${item.action}:${item.reason ?? "unknown"}`);
    }
  }

  const repaired = items.some((x) => !!x.repairedAt || x.action === "restored-from-backup" || x.action === "backup-created");
  const ok = items.some((x) => x.target === "chain" && x.validShape);

  const prev = repairStatsByChainFile.get(chainFile);
  const stats: ChainRepairStats = {
    checkedAt,
    chainFile,
    lastOk: ok,
    lastRepaired: repaired,
    lastErrors: errors,
    totalChecks: (prev?.totalChecks ?? 0) + 1,
    totalRepairs: (prev?.totalRepairs ?? 0) + (repaired ? 1 : 0),
    totalQuarantined:
      (prev?.totalQuarantined ?? 0) + items.filter((x) => x.action === "quarantined-corrupt").length,
    totalRestoreFromBackup:
      (prev?.totalRestoreFromBackup ?? 0) + items.filter((x) => x.action === "restored-from-backup").length,
    lastItems: items,
  };

  repairStatsByChainFile.set(chainFile, stats);

  if (repaired) {
    console.log(
      `🩹 chain auto-repair checked ${chainFile} | repaired=${repaired} | restored=${items.filter((x) => x.action === "restored-from-backup").length} | quarantined=${items.filter((x) => x.action === "quarantined-corrupt").length}`
    );
  }

  return {
    ok,
    chainFile,
    repaired,
    checkedAt,
    items,
    errors,
  };
}

export function getChainRepairStats(chainFile: string): ChainRepairStats {
  const existing = repairStatsByChainFile.get(chainFile);
  if (existing) return existing;

  return {
    checkedAt: 0,
    chainFile,
    lastOk: false,
    lastRepaired: false,
    lastErrors: [],
    totalChecks: 0,
    totalRepairs: 0,
    totalQuarantined: 0,
    totalRestoreFromBackup: 0,
    lastItems: [],
  };
}
