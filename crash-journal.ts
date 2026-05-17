// crash-journal.ts
import * as fs from "fs";
import * as pathMod from "path";

/* =========================
   Crash Recovery Journal
   Phase 9.9
========================= */

export type CrashJournalStage =
  | "begin"
  | "chain-save"
  | "chain-backup"
  | "snapshot-save"
  | "snapshot-backup"
  | "chainstate-save"
  | "chainstate-backup"
  | "checkpoint-import"
  | "prune"
  | "complete"
  | "abort";

export type CrashJournalStatus =
  | "open"
  | "complete"
  | "aborted"
  | "recovered"
  | "corrupt";

export type CrashJournalEntry = {
  id: string;
  version: number;

  chainFile: string;
  operation: string;
  stage: CrashJournalStage;
  status: CrashJournalStatus;

  height: number;
  tipHash: string;
  stateRoot: string | null;

  startedAt: number;
  updatedAt: number;
  completedAt: number;

  pid: number;
  note: string | null;

  files: {
    chainFile?: string;
    chainBackupFile?: string;
    snapshotFile?: string;
    snapshotBackupFile?: string;
    chainstateFile?: string;
    chainstateBackupFile?: string;
  };

  error: string | null;
};

export type CrashJournalRecoveryResult = {
  ok: boolean;
  journalFile: string;
  backupFile: string;
  recovered: boolean;
  reason: string;
  entry: CrashJournalEntry | null;
};

export type CrashJournalStats = {
  journalFile: string;
  backupFile: string;
  exists: boolean;
  backupExists: boolean;
  bytes: number;
  backupBytes: number;
  hasOpenJournal: boolean;
  lastStatus: CrashJournalStatus | null;
  lastOperation: string | null;
  lastStage: CrashJournalStage | null;
  lastHeight: number | null;
  lastTipHash: string | null;
  lastUpdatedAt: number | null;
  lastCompletedAt: number | null;
  recoveryCount: number;
  corruptCount: number;
};

const JOURNAL_VERSION = 1;

let recoveryCount = 0;
let corruptCount = 0;

function now() {
  return Date.now();
}

function isObj(x: any) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function isSafeInt(n: any) {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
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
  const tmp = pathMod.join(
    dir,
    `.${base}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );

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

function safeFileSize(filePath: string) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function safeReadJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function makeJournalId(operation: string) {
  return `journal_${operation}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeError(e: any) {
  return e?.message ?? String(e);
}

function validateCrashJournalEntry(raw: any): raw is CrashJournalEntry {
  if (!isObj(raw)) return false;
  if (raw.version !== JOURNAL_VERSION) return false;

  if (typeof raw.id !== "string" || !raw.id) return false;
  if (typeof raw.chainFile !== "string" || !raw.chainFile) return false;
  if (typeof raw.operation !== "string" || !raw.operation) return false;

  if (typeof raw.stage !== "string") return false;
  if (typeof raw.status !== "string") return false;

  if (!isSafeInt(raw.height) || raw.height < 0) return false;
  if (typeof raw.tipHash !== "string") return false;
  if (raw.stateRoot !== null && typeof raw.stateRoot !== "string") return false;

  if (!isSafeInt(raw.startedAt) || raw.startedAt <= 0) return false;
  if (!isSafeInt(raw.updatedAt) || raw.updatedAt <= 0) return false;
  if (!isSafeInt(raw.completedAt) || raw.completedAt < 0) return false;

  if (!isSafeInt(raw.pid) || raw.pid <= 0) return false;
  if (raw.note !== null && typeof raw.note !== "string") return false;
  if (!isObj(raw.files)) return false;
  if (raw.error !== null && typeof raw.error !== "string") return false;

  return true;
}

export function crashJournalFileFor(chainFile: string) {
  return chainFile.replace(/\.json$/, "") + ".crash-journal.json";
}

export function crashJournalBackupFileFor(chainFile: string) {
  return crashJournalFileFor(chainFile) + ".bak";
}

export function readCrashJournal(chainFile: string): CrashJournalEntry | null {
  const file = crashJournalFileFor(chainFile);
  const backupFile = crashJournalBackupFileFor(chainFile);

  const primary = safeReadJson(file);
  if (validateCrashJournalEntry(primary)) return primary;

  if (primary !== null) {
    corruptCount++;
  }

  const backup = safeReadJson(backupFile);
  if (validateCrashJournalEntry(backup)) return backup;

  if (backup !== null) {
    corruptCount++;
  }

  return null;
}

export function writeCrashJournal(chainFile: string, entry: CrashJournalEntry): boolean {
  const file = crashJournalFileFor(chainFile);
  const backupFile = crashJournalBackupFileFor(chainFile);

  try {
    const text = JSON.stringify(entry, null, 2);
    writeTextAtomic(file, text);

    try {
      copyFileAtomic(file, backupFile);
    } catch {}

    return true;
  } catch (e: any) {
    console.log(`⚠️ crash journal write failed ${file}: ${normalizeError(e)}`);
    return false;
  }
}

export function deleteCrashJournal(chainFile: string): boolean {
  const file = crashJournalFileFor(chainFile);
  const backupFile = crashJournalBackupFileFor(chainFile);

  let ok = true;

  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fsyncDirBestEffort(file);
  } catch {
    ok = false;
  }

  try {
    if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
    fsyncDirBestEffort(backupFile);
  } catch {
    ok = false;
  }

  return ok;
}

export function beginCrashJournal(args: {
  chainFile: string;
  operation: string;
  height: number;
  tipHash: string;
  stateRoot?: string | null;
  note?: string | null;
  files?: CrashJournalEntry["files"];
}): CrashJournalEntry {
  const ts = now();

  const entry: CrashJournalEntry = {
    id: makeJournalId(args.operation),
    version: JOURNAL_VERSION,

    chainFile: args.chainFile,
    operation: args.operation,
    stage: "begin",
    status: "open",

    height: args.height,
    tipHash: args.tipHash,
    stateRoot: args.stateRoot ?? null,

    startedAt: ts,
    updatedAt: ts,
    completedAt: 0,

    pid: process.pid,
    note: args.note ?? null,

    files: args.files ?? {},

    error: null,
  };

  writeCrashJournal(args.chainFile, entry);
  return entry;
}

export function updateCrashJournal(
  chainFile: string,
  updates: Partial<
    Pick<
      CrashJournalEntry,
      "stage" | "status" | "height" | "tipHash" | "stateRoot" | "note" | "files" | "error"
    >
  >
): CrashJournalEntry | null {
  const existing = readCrashJournal(chainFile);
  if (!existing) return null;

  const ts = now();

  const next: CrashJournalEntry = {
    ...existing,
    ...updates,
    files: {
      ...existing.files,
      ...(updates.files ?? {}),
    },
    updatedAt: ts,
    completedAt:
      updates.status === "complete" || updates.status === "aborted" || updates.status === "recovered"
        ? ts
        : existing.completedAt,
  };

  writeCrashJournal(chainFile, next);
  return next;
}

export function completeCrashJournal(chainFile: string, note = "complete") {
  return updateCrashJournal(chainFile, {
    stage: "complete",
    status: "complete",
    note,
    error: null,
  });
}

export function abortCrashJournal(chainFile: string, error: string) {
  return updateCrashJournal(chainFile, {
    stage: "abort",
    status: "aborted",
    note: "aborted",
    error,
  });
}

export function recoverCrashJournal(chainFile: string): CrashJournalRecoveryResult {
  const journalFile = crashJournalFileFor(chainFile);
  const backupFile = crashJournalBackupFileFor(chainFile);
  const entry = readCrashJournal(chainFile);

  if (!entry) {
    return {
      ok: true,
      journalFile,
      backupFile,
      recovered: false,
      reason: "no-journal",
      entry: null,
    };
  }

  if (entry.status === "complete" || entry.status === "recovered" || entry.status === "aborted") {
    return {
      ok: true,
      journalFile,
      backupFile,
      recovered: false,
      reason: `journal-status-${entry.status}`,
      entry,
    };
  }

  if (entry.status !== "open") {
    corruptCount++;

    return {
      ok: false,
      journalFile,
      backupFile,
      recovered: false,
      reason: `bad-journal-status-${entry.status}`,
      entry,
    };
  }

  recoveryCount++;

  console.log(
    `🧯 crash journal detected | operation=${entry.operation} | stage=${entry.stage} | height=${entry.height} | tip=${entry.tipHash.slice(
      0,
      12
    )}...`
  );

  const recovered = updateCrashJournal(chainFile, {
    status: "recovered",
    note: "Recovered open journal after restart. Existing chain load/validation will decide final state.",
  });

  return {
    ok: true,
    journalFile,
    backupFile,
    recovered: true,
    reason: "open-journal-marked-recovered",
    entry: recovered ?? entry,
  };
}

export function getCrashJournalStats(chainFile: string): CrashJournalStats {
  const journalFile = crashJournalFileFor(chainFile);
  const backupFile = crashJournalBackupFileFor(chainFile);
  const entry = readCrashJournal(chainFile);

  return {
    journalFile,
    backupFile,
    exists: fs.existsSync(journalFile),
    backupExists: fs.existsSync(backupFile),
    bytes: safeFileSize(journalFile),
    backupBytes: safeFileSize(backupFile),

    hasOpenJournal: entry?.status === "open",
    lastStatus: entry?.status ?? null,
    lastOperation: entry?.operation ?? null,
    lastStage: entry?.stage ?? null,
    lastHeight: entry?.height ?? null,
    lastTipHash: entry?.tipHash ?? null,
    lastUpdatedAt: entry?.updatedAt ?? null,
    lastCompletedAt: entry?.completedAt ?? null,

    recoveryCount,
    corruptCount,
  };
}

export function withCrashJournal<T>(
  args: {
    chainFile: string;
    operation: string;
    height: number;
    tipHash: string;
    stateRoot?: string | null;
    note?: string | null;
    files?: CrashJournalEntry["files"];
  },
  fn: (journal: CrashJournalEntry) => T
): T {
  const journal = beginCrashJournal(args);

  try {
    const out = fn(journal);
    completeCrashJournal(args.chainFile);
    return out;
  } catch (e: any) {
    abortCrashJournal(args.chainFile, normalizeError(e));
    throw e;
  }
}