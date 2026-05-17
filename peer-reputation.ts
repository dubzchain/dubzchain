// peer-reputation.ts

export type PeerReputationLevel =
  | "trusted"
  | "good"
  | "neutral"
  | "warn"
  | "bad"
  | "banned";

export type PeerBanKind = "none" | "temporary" | "escalated" | "manual";

export type PeerReputationEvent =
  | "connect"
  | "disconnect"
  | "message-ok"
  | "headers-ok"
  | "block-ok"
  | "compact-block-ok"
  | "tx-ok"
  | "mempool-ok"
  | "proof-ok"
  | "snapshot-ok"
  | "rate-limit"
  | "bad-message"
  | "bad-envelope"
  | "bad-headers"
  | "bad-block"
  | "bad-compact-block"
  | "bad-tx"
  | "bad-mempool-response"
  | "bad-proof"
  | "bad-snapshot"
  | "timeout"
  | "socket-error"
  | "manual-ban";

export type PeerBanHistoryItem = {
  at: number;
  until: number;
  durationMs: number;
  kind: PeerBanKind;
  reason: string;
  scoreAtBan: number;
  banCount: number;
};

export type PeerReputationRecord = {
  peer: string;
  score: number;
  level: PeerReputationLevel;

  connectedCount: number;
  disconnectCount: number;

  goodEvents: number;
  badEvents: number;

  lastEvent: PeerReputationEvent | null;
  lastReason: string | null;

  firstSeenAt: number;
  lastSeenAt: number;
  lastGoodAt: number;
  lastBadAt: number;

  bannedUntil: number;
  banStartedAt: number;
  banDurationMs: number;
  banReason: string | null;
  banKind: PeerBanKind;
  banCount: number;
  banHistory: PeerBanHistoryItem[];

  lastDecayAt: number;
  decayCount: number;
  expiredBanCount: number;
  manualUnbanCount: number;
};

export type PeerReputationSnapshot = {
  peer: string;
  score: number;
  level: PeerReputationLevel;

  connectedCount: number;
  disconnectCount: number;

  goodEvents: number;
  badEvents: number;

  lastEvent: PeerReputationEvent | null;
  lastReason: string | null;

  firstSeenAt: number;
  lastSeenAt: number;
  lastGoodAt: number;
  lastBadAt: number;

  bannedUntil: number;
  banStartedAt: number;
  banDurationMs: number;
  banReason: string | null;
  banKind: PeerBanKind;
  banCount: number;
  banHistory: PeerBanHistoryItem[];

  isBanned: boolean;
  banRemainingMs: number;

  lastDecayAt: number;
  decayCount: number;
  expiredBanCount: number;
  manualUnbanCount: number;
};

const DEFAULT_SCORE = 0;
const MIN_SCORE = -100;
const MAX_SCORE = 100;

const WARN_SCORE = -20;
const BAD_SCORE = -50;
const GOOD_SCORE = 15;
const TRUSTED_SCORE = 50;

const BASE_BAN_MS = 60_000;
const MAX_BAN_MS = 30 * 60_000;

const DECAY_INTERVAL_MS = 60_000;
const POSITIVE_DECAY_STEP = 1;
const NEGATIVE_DECAY_STEP = 2;

const BAN_HISTORY_MAX = 20;
const AUTO_BAN_SCORE = BAD_SCORE;

const EVENT_SCORE: Record<PeerReputationEvent, number> = {
  connect: 2,
  disconnect: -1,

  "message-ok": 1,
  "headers-ok": 4,
  "block-ok": 8,
  "compact-block-ok": 6,
  "tx-ok": 3,
  "mempool-ok": 2,
  "proof-ok": 3,
  "snapshot-ok": 8,

  "rate-limit": -20,
  "bad-message": -35,
  "bad-envelope": -25,
  "bad-headers": -35,
  "bad-block": -45,
  "bad-compact-block": -35,
  "bad-tx": -20,
  "bad-mempool-response": -20,
  "bad-proof": -20,
  "bad-snapshot": -45,
  timeout: -8,
  "socket-error": -6,
  "manual-ban": -100,
};

function now() {
  return Date.now();
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function isBadEvent(event: PeerReputationEvent) {
  return EVENT_SCORE[event] < 0;
}

function isGoodEvent(event: PeerReputationEvent) {
  return EVENT_SCORE[event] > 0;
}

function levelForScore(score: number, bannedUntil: number): PeerReputationLevel {
  if (bannedUntil > now()) return "banned";
  if (score >= TRUSTED_SCORE) return "trusted";
  if (score >= GOOD_SCORE) return "good";
  if (score <= BAD_SCORE) return "bad";
  if (score <= WARN_SCORE) return "warn";
  return "neutral";
}

function banKindFor(rec: PeerReputationRecord, manual: boolean): PeerBanKind {
  if (manual) return "manual";
  if (rec.banCount >= 2 || rec.score <= -75) return "escalated";
  return "temporary";
}

function banDurationFor(rec: PeerReputationRecord, kind: PeerBanKind): number {
  if (kind === "manual") return MAX_BAN_MS;

  const base = BASE_BAN_MS * Math.pow(2, Math.max(0, rec.banCount - 1));
  const scorePenalty = rec.score <= -90 ? 4 : rec.score <= -75 ? 2 : 1;

  return clamp(base * scorePenalty, BASE_BAN_MS, MAX_BAN_MS);
}

function createRecord(peer: string): PeerReputationRecord {
  const ts = now();

  return {
    peer,
    score: DEFAULT_SCORE,
    level: "neutral",

    connectedCount: 0,
    disconnectCount: 0,

    goodEvents: 0,
    badEvents: 0,

    lastEvent: null,
    lastReason: null,

    firstSeenAt: ts,
    lastSeenAt: ts,
    lastGoodAt: 0,
    lastBadAt: 0,

    bannedUntil: 0,
    banStartedAt: 0,
    banDurationMs: 0,
    banReason: null,
    banKind: "none",
    banCount: 0,
    banHistory: [],

    lastDecayAt: ts,
    decayCount: 0,
    expiredBanCount: 0,
    manualUnbanCount: 0,
  };
}

export class PeerReputationBook {
  private peers = new Map<string, PeerReputationRecord>();
  private lastGlobalDecayAt = now();

  getOrCreate(peer: string): PeerReputationRecord {
    const key = String(peer || "unknown");
    const existing = this.peers.get(key);
    if (existing) return existing;

    const rec = createRecord(key);
    this.peers.set(key, rec);
    return rec;
  }

  record(peer: string, event: PeerReputationEvent, reason?: string): PeerReputationSnapshot {
    this.decayIfNeeded();
    this.clearExpiredBans();

    const rec = this.getOrCreate(peer);
    const ts = now();
    const delta = EVENT_SCORE[event] ?? 0;

    rec.score = clamp(rec.score + delta, MIN_SCORE, MAX_SCORE);
    rec.lastSeenAt = ts;
    rec.lastEvent = event;
    rec.lastReason = reason ?? null;

    if (event === "connect") rec.connectedCount++;
    if (event === "disconnect") rec.disconnectCount++;

    if (isGoodEvent(event)) {
      rec.goodEvents++;
      rec.lastGoodAt = ts;
    }

    if (isBadEvent(event)) {
      rec.badEvents++;
      rec.lastBadAt = ts;
    }

    rec.level = levelForScore(rec.score, rec.bannedUntil);
    return this.snapshot(peer);
  }

  reward(peer: string, event: PeerReputationEvent = "message-ok", reason?: string): PeerReputationSnapshot {
    return this.record(peer, event, reason);
  }

  punish(peer: string, event: PeerReputationEvent, reason?: string): PeerReputationSnapshot {
    const snap = this.record(peer, event, reason);
    const rec = this.getOrCreate(peer);

    if (event === "manual-ban") {
      return this.ban(peer, reason || "manual-ban", true);
    }

    if (rec.score <= AUTO_BAN_SCORE) {
      return this.ban(peer, reason || event, false);
    }

    return snap;
  }

  ban(peer: string, reason = "ban", manual = false): PeerReputationSnapshot {
    const rec = this.getOrCreate(peer);
    const ts = now();

    rec.banCount++;
    rec.score = clamp(Math.min(rec.score, BAD_SCORE), MIN_SCORE, MAX_SCORE);

    const kind = banKindFor(rec, manual);
    const durationMs = banDurationFor(rec, kind);
    const until = ts + durationMs;

    rec.bannedUntil = until;
    rec.banStartedAt = ts;
    rec.banDurationMs = durationMs;
    rec.banReason = reason;
    rec.banKind = kind;

    rec.lastSeenAt = ts;
    rec.lastBadAt = ts;
    rec.lastEvent = manual ? "manual-ban" : rec.lastEvent;
    rec.lastReason = reason;
    rec.level = "banned";

    rec.banHistory.unshift({
      at: ts,
      until,
      durationMs,
      kind,
      reason,
      scoreAtBan: rec.score,
      banCount: rec.banCount,
    });

    while (rec.banHistory.length > BAN_HISTORY_MAX) {
      rec.banHistory.pop();
    }

    return this.snapshot(peer);
  }

  manualBan(peer: string, reason = "manual-ban"): PeerReputationSnapshot {
    return this.ban(peer, reason, true);
  }

  manualUnban(peer: string, reason = "manual-unban"): PeerReputationSnapshot {
    const rec = this.getOrCreate(peer);

    rec.bannedUntil = 0;
    rec.banStartedAt = 0;
    rec.banDurationMs = 0;
    rec.banReason = reason;
    rec.banKind = "none";
    rec.manualUnbanCount++;
    rec.lastReason = reason;
    rec.lastSeenAt = now();
    rec.level = levelForScore(rec.score, rec.bannedUntil);

    return this.snapshot(peer);
  }

  isBanned(peer: string): boolean {
    const rec = this.getOrCreate(peer);
    const ts = now();

    if (rec.bannedUntil > ts) {
      rec.level = "banned";
      return true;
    }

    if (rec.bannedUntil > 0 && rec.bannedUntil <= ts) {
      rec.expiredBanCount++;
      rec.bannedUntil = 0;
      rec.banStartedAt = 0;
      rec.banDurationMs = 0;
      rec.banReason = null;
      rec.banKind = "none";
      rec.level = levelForScore(rec.score, 0);
      return false;
    }

    rec.level = levelForScore(rec.score, rec.bannedUntil);
    return false;
  }

  shouldReject(peer: string): { reject: boolean; reason?: string; snapshot: PeerReputationSnapshot } {
    const banned = this.isBanned(peer);
    const snapshot = this.snapshot(peer);

    if (banned) {
      return {
        reject: true,
        reason: `reputation-ban remainingMs=${snapshot.banRemainingMs}`,
        snapshot,
      };
    }

    return {
      reject: false,
      snapshot,
    };
  }

  score(peer: string): number {
    return this.getOrCreate(peer).score;
  }

  level(peer: string): PeerReputationLevel {
    const rec = this.getOrCreate(peer);
    rec.level = levelForScore(rec.score, rec.bannedUntil);
    return rec.level;
  }

  snapshot(peer: string): PeerReputationSnapshot {
    const rec = this.getOrCreate(peer);
    const ts = now();

    if (rec.bannedUntil > 0 && rec.bannedUntil <= ts) {
      rec.expiredBanCount++;
      rec.bannedUntil = 0;
      rec.banStartedAt = 0;
      rec.banDurationMs = 0;
      rec.banReason = null;
      rec.banKind = "none";
    }

    rec.level = levelForScore(rec.score, rec.bannedUntil);

    return {
      peer: rec.peer,
      score: rec.score,
      level: rec.level,

      connectedCount: rec.connectedCount,
      disconnectCount: rec.disconnectCount,

      goodEvents: rec.goodEvents,
      badEvents: rec.badEvents,

      lastEvent: rec.lastEvent,
      lastReason: rec.lastReason,

      firstSeenAt: rec.firstSeenAt,
      lastSeenAt: rec.lastSeenAt,
      lastGoodAt: rec.lastGoodAt,
      lastBadAt: rec.lastBadAt,

      bannedUntil: rec.bannedUntil,
      banStartedAt: rec.banStartedAt,
      banDurationMs: rec.banDurationMs,
      banReason: rec.banReason,
      banKind: rec.banKind,
      banCount: rec.banCount,
      banHistory: rec.banHistory.slice(),

      isBanned: rec.bannedUntil > ts,
      banRemainingMs: Math.max(0, rec.bannedUntil - ts),

      lastDecayAt: rec.lastDecayAt,
      decayCount: rec.decayCount,
      expiredBanCount: rec.expiredBanCount,
      manualUnbanCount: rec.manualUnbanCount,
    };
  }

  snapshots(): PeerReputationSnapshot[] {
    this.decayIfNeeded();
    this.clearExpiredBans();

    return Array.from(this.peers.keys())
      .map((peer) => this.snapshot(peer))
      .sort((a, b) => {
        if (a.level === "banned" && b.level !== "banned") return -1;
        if (a.level !== "banned" && b.level === "banned") return 1;
        return b.score - a.score;
      });
  }

  decayIfNeeded() {
    const ts = now();
    if (ts - this.lastGlobalDecayAt < DECAY_INTERVAL_MS) return;

    const steps = Math.max(1, Math.floor((ts - this.lastGlobalDecayAt) / DECAY_INTERVAL_MS));
    this.lastGlobalDecayAt = ts;

    for (const rec of this.peers.values()) {
      if (rec.bannedUntil > ts) {
        rec.level = "banned";
        continue;
      }

      const oldScore = rec.score;

      if (rec.score > 0) {
        rec.score = Math.max(0, rec.score - POSITIVE_DECAY_STEP * steps);
      } else if (rec.score < 0) {
        rec.score = Math.min(0, rec.score + NEGATIVE_DECAY_STEP * steps);
      }

      if (rec.score !== oldScore) {
        rec.decayCount += steps;
        rec.lastDecayAt = ts;
      }

      rec.level = levelForScore(rec.score, rec.bannedUntil);
    }
  }

  clearExpiredBans() {
    const ts = now();

    for (const rec of this.peers.values()) {
      if (rec.bannedUntil > 0 && rec.bannedUntil <= ts) {
        rec.expiredBanCount++;
        rec.bannedUntil = 0;
        rec.banStartedAt = 0;
        rec.banDurationMs = 0;
        rec.banReason = null;
        rec.banKind = "none";
        rec.level = levelForScore(rec.score, 0);
      }
    }
  }

  clearPeer(peer: string) {
    this.peers.delete(peer);
  }

  clearAll() {
    this.peers.clear();
  }
}

export const peerReputation = new PeerReputationBook();