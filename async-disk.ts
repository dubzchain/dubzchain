// async-disk.ts
import * as fs from "fs";
import * as pathMod from "path";

/* =========================
   Async Disk Write Queue
   Phase 9.8
========================= */

export type AsyncDiskJobType =
  | "write-text"
  | "write-json"
  | "copy-file"
  | "delete-file";

export type AsyncDiskJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed";

export type AsyncDiskJob = {
  id: string;
  type: AsyncDiskJobType;
  status: AsyncDiskJobStatus;

  filePath: string;
  backupPath?: string | null;

  text?: string;
  json?: any;

  queuedAt: number;
  startedAt: number;
  finishedAt: number;

  attempts: number;
  maxAttempts: number;

  error: string | null;
};

export type AsyncDiskQueueStats = {
  enabled: boolean;
  running: boolean;
  queueLength: number;
  pendingJobs: number;
  completedJobs: number;
  failedJobs: number;
  totalQueued: number;
  totalCompleted: number;
  totalFailed: number;
  totalRetries: number;
  lastJobId: string | null;
  lastJobType: AsyncDiskJobType | null;
  lastJobFile: string | null;
  lastError: string | null;
  lastRunAt: number;
  lastDrainAt: number;
};

export type AsyncDiskQueueOptions = {
  enabled?: boolean;
  maxAttempts?: number;
  retryDelayMs?: number;
  keepCompleted?: number;
  keepFailed?: number;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_KEEP_COMPLETED = 100;
const DEFAULT_KEEP_FAILED = 100;

function now() {
  return Date.now();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function makeJobId(type: AsyncDiskJobType) {
  return `${type}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
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

function writeTextAtomicSync(filePath: string, text: string) {
  const dir = pathMod.dirname(filePath) || ".";
  const base = pathMod.basename(filePath);
  const tmp = pathMod.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);

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

function copyFileAtomicSync(srcPath: string, dstPath: string) {
  const dir = pathMod.dirname(dstPath) || ".";
  const base = pathMod.basename(dstPath);
  const tmp = pathMod.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);

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

function deleteFileBestEffortSync(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fsyncDirBestEffort(filePath);
  } catch {}
}

export class AsyncDiskWriteQueue {
  private enabled: boolean;
  private maxAttempts: number;
  private retryDelayMs: number;
  private keepCompleted: number;
  private keepFailed: number;

  private queue: AsyncDiskJob[] = [];
  private completed: AsyncDiskJob[] = [];
  private failed: AsyncDiskJob[] = [];

  private running = false;
  private drainPromise: Promise<void> | null = null;

  private totalQueued = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalRetries = 0;

  private lastJobId: string | null = null;
  private lastJobType: AsyncDiskJobType | null = null;
  private lastJobFile: string | null = null;
  private lastError: string | null = null;
  private lastRunAt = 0;
  private lastDrainAt = 0;

  constructor(opts: AsyncDiskQueueOptions = {}) {
    this.enabled = opts.enabled !== false;
    this.maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.retryDelayMs = Math.max(0, Math.floor(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    this.keepCompleted = Math.max(0, Math.floor(opts.keepCompleted ?? DEFAULT_KEEP_COMPLETED));
    this.keepFailed = Math.max(0, Math.floor(opts.keepFailed ?? DEFAULT_KEEP_FAILED));
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  stats(): AsyncDiskQueueStats {
    return {
      enabled: this.enabled,
      running: this.running,
      queueLength: this.queue.length,
      pendingJobs: this.queue.filter((j) => j.status === "queued" || j.status === "running").length,
      completedJobs: this.completed.length,
      failedJobs: this.failed.length,
      totalQueued: this.totalQueued,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalRetries: this.totalRetries,
      lastJobId: this.lastJobId,
      lastJobType: this.lastJobType,
      lastJobFile: this.lastJobFile,
      lastError: this.lastError,
      lastRunAt: this.lastRunAt,
      lastDrainAt: this.lastDrainAt,
    };
  }

  enqueueWriteText(filePath: string, text: string, backupPath?: string | null): AsyncDiskJob {
    const job = this.makeJob("write-text", filePath, {
      text,
      backupPath,
    });

    return this.enqueue(job);
  }

  enqueueWriteJson(filePath: string, json: any, backupPath?: string | null): AsyncDiskJob {
    const job = this.makeJob("write-json", filePath, {
      json,
      backupPath,
    });

    return this.enqueue(job);
  }

  enqueueCopyFile(filePath: string, backupPath: string): AsyncDiskJob {
    const job = this.makeJob("copy-file", filePath, {
      backupPath,
    });

    return this.enqueue(job);
  }

  enqueueDeleteFile(filePath: string): AsyncDiskJob {
    const job = this.makeJob("delete-file", filePath, {});

    return this.enqueue(job);
  }

  writeText(filePath: string, text: string, backupPath?: string | null) {
    if (!this.enabled) {
      writeTextAtomicSync(filePath, text);
      if (backupPath) copyFileAtomicSync(filePath, backupPath);
      return null;
    }

    return this.enqueueWriteText(filePath, text, backupPath);
  }

  writeJson(filePath: string, obj: any, backupPath?: string | null) {
    if (!this.enabled) {
      writeTextAtomicSync(filePath, JSON.stringify(obj, null, 2));
      if (backupPath) copyFileAtomicSync(filePath, backupPath);
      return null;
    }

    return this.enqueueWriteJson(filePath, obj, backupPath);
  }

  copyFile(filePath: string, backupPath: string) {
    if (!this.enabled) {
      copyFileAtomicSync(filePath, backupPath);
      return null;
    }

    return this.enqueueCopyFile(filePath, backupPath);
  }

  deleteFile(filePath: string) {
    if (!this.enabled) {
      deleteFileBestEffortSync(filePath);
      return null;
    }

    return this.enqueueDeleteFile(filePath);
  }

  async flush(): Promise<void> {
    this.start();
    while (this.running || this.queue.length > 0) {
      await sleep(10);
    }
  }

  start() {
    if (!this.enabled) return;
    if (this.running) return;

    this.drainPromise = this.drain();
  }

  async stopAndFlush(): Promise<void> {
    await this.flush();
  }

  clearCompleted() {
    this.completed.length = 0;
  }

  clearFailed() {
    this.failed.length = 0;
  }

  private makeJob(
    type: AsyncDiskJobType,
    filePath: string,
    extra: {
      backupPath?: string | null;
      text?: string;
      json?: any;
    }
  ): AsyncDiskJob {
    const ts = now();

    return {
      id: makeJobId(type),
      type,
      status: "queued",

      filePath,
      backupPath: extra.backupPath ?? null,

      text: extra.text,
      json: extra.json,

      queuedAt: ts,
      startedAt: 0,
      finishedAt: 0,

      attempts: 0,
      maxAttempts: this.maxAttempts,

      error: null,
    };
  }

  private enqueue(job: AsyncDiskJob): AsyncDiskJob {
    this.queue.push(job);
    this.totalQueued++;

    this.lastJobId = job.id;
    this.lastJobType = job.type;
    this.lastJobFile = job.filePath;

    this.start();
    return job;
  }

  private async drain() {
    if (this.running) return;

    this.running = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) continue;

        await this.runJobWithRetry(job);
      }
    } finally {
      this.running = false;
      this.lastDrainAt = now();
      this.drainPromise = null;
    }
  }

  private async runJobWithRetry(job: AsyncDiskJob) {
    while (job.attempts < job.maxAttempts) {
      job.attempts++;
      job.status = "running";
      job.startedAt = job.startedAt || now();

      this.lastRunAt = now();
      this.lastJobId = job.id;
      this.lastJobType = job.type;
      this.lastJobFile = job.filePath;

      try {
        this.runJob(job);

        job.status = "done";
        job.finishedAt = now();
        job.error = null;

        this.completed.unshift(job);
        this.totalCompleted++;
        this.capLists();

        return;
      } catch (e: any) {
        job.error = e?.message ?? String(e);
        this.lastError = job.error;

        if (job.attempts < job.maxAttempts) {
          this.totalRetries++;
          await sleep(this.retryDelayMs * job.attempts);
          continue;
        }

        job.status = "failed";
        job.finishedAt = now();

        this.failed.unshift(job);
        this.totalFailed++;
        this.capLists();

        console.log(
          `⚠️ async disk job failed id=${job.id} type=${job.type} file=${job.filePath} attempts=${job.attempts} error=${job.error}`
        );

        return;
      }
    }
  }

  private runJob(job: AsyncDiskJob) {
    if (job.type === "write-text") {
      writeTextAtomicSync(job.filePath, job.text ?? "");
      if (job.backupPath) copyFileAtomicSync(job.filePath, job.backupPath);
      return;
    }

    if (job.type === "write-json") {
      writeTextAtomicSync(job.filePath, JSON.stringify(job.json ?? null, null, 2));
      if (job.backupPath) copyFileAtomicSync(job.filePath, job.backupPath);
      return;
    }

    if (job.type === "copy-file") {
      if (!job.backupPath) throw new Error("copy-file missing backupPath");
      copyFileAtomicSync(job.filePath, job.backupPath);
      return;
    }

    if (job.type === "delete-file") {
      deleteFileBestEffortSync(job.filePath);
      return;
    }

    throw new Error(`unknown async disk job type: ${(job as any).type}`);
  }

  private capLists() {
    while (this.completed.length > this.keepCompleted) {
      this.completed.pop();
    }

    while (this.failed.length > this.keepFailed) {
      this.failed.pop();
    }
  }
}

export const asyncDiskQueue = new AsyncDiskWriteQueue({
  enabled: true,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  keepCompleted: DEFAULT_KEEP_COMPLETED,
  keepFailed: DEFAULT_KEEP_FAILED,
});

export function getAsyncDiskQueueStats() {
  return asyncDiskQueue.stats();
}

export async function flushAsyncDiskQueue() {
  await asyncDiskQueue.flush();
}

export async function stopAndFlushAsyncDiskQueue() {
  await asyncDiskQueue.stopAndFlush();
}