// bandwidth-throttle.ts

/* =========================
   Bandwidth Throttling
   Phase 9.11
========================= */

export type BandwidthDirection = "inbound" | "outbound";

export type BandwidthThrottleDecision = {
  allowed: boolean;
  peer: string;
  direction: BandwidthDirection;
  bytes: number;
  usedBytes: number;
  limitBytes: number;
  windowStartedAt: number;
  windowMs: number;
  resetInMs: number;
  reason?: string;
};

export type BandwidthPeerSnapshot = {
  peer: string;

  inboundWindowBytes: number;
  outboundWindowBytes: number;

  inboundLimitBytes: number;
  outboundLimitBytes: number;

  inboundWindowStartedAt: number;
  outboundWindowStartedAt: number;

  inboundResetInMs: number;
  outboundResetInMs: number;

  inboundAllowed: number;
  outboundAllowed: number;

  inboundRejected: number;
  outboundRejected: number;

  inboundBytesAllowed: number;
  outboundBytesAllowed: number;

  inboundBytesRejected: number;
  outboundBytesRejected: number;

  lastInboundAt: number;
  lastOutboundAt: number;
  lastRejectAt: number;
  lastRejectReason: string | null;
};

export type BandwidthThrottleSummary = {
  enabled: boolean;
  windowMs: number;
  inboundLimitBytes: number;
  outboundLimitBytes: number;
  trackedPeers: number;

  totalInboundAllowed: number;
  totalOutboundAllowed: number;
  totalInboundRejected: number;
  totalOutboundRejected: number;

  totalInboundBytesAllowed: number;
  totalOutboundBytesAllowed: number;
  totalInboundBytesRejected: number;
  totalOutboundBytesRejected: number;

  peers: BandwidthPeerSnapshot[];
};

export type BandwidthThrottleOptions = {
  enabled?: boolean;
  windowMs?: number;
  inboundLimitBytes?: number;
  outboundLimitBytes?: number;
};

type BandwidthWindow = {
  startedAt: number;
  bytes: number;
};

type BandwidthPeerState = {
  peer: string;

  inbound: BandwidthWindow;
  outbound: BandwidthWindow;

  inboundAllowed: number;
  outboundAllowed: number;

  inboundRejected: number;
  outboundRejected: number;

  inboundBytesAllowed: number;
  outboundBytesAllowed: number;

  inboundBytesRejected: number;
  outboundBytesRejected: number;

  lastInboundAt: number;
  lastOutboundAt: number;
  lastRejectAt: number;
  lastRejectReason: string | null;
};

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_INBOUND_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_LIMIT_BYTES = 8 * 1024 * 1024;

function now() {
  return Date.now();
}

function cleanPeer(peer: string) {
  const p = String(peer || "unknown").trim();
  return p || "unknown";
}

function cleanBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.floor(bytes);
}

export class BandwidthThrottleBook {
  private enabled: boolean;
  private windowMs: number;
  private inboundLimitBytes: number;
  private outboundLimitBytes: number;
  private peers = new Map<string, BandwidthPeerState>();

  constructor(opts: BandwidthThrottleOptions = {}) {
    this.enabled = opts.enabled !== false;
    this.windowMs = Math.max(1000, Math.floor(opts.windowMs ?? DEFAULT_WINDOW_MS));
    this.inboundLimitBytes = Math.max(1024, Math.floor(opts.inboundLimitBytes ?? DEFAULT_INBOUND_LIMIT_BYTES));
    this.outboundLimitBytes = Math.max(1024, Math.floor(opts.outboundLimitBytes ?? DEFAULT_OUTBOUND_LIMIT_BYTES));
  }

  isEnabled() {
    return this.enabled;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  getOrCreate(peer: string): BandwidthPeerState {
    const key = cleanPeer(peer);
    const existing = this.peers.get(key);
    if (existing) return existing;

    const ts = now();
    const state: BandwidthPeerState = {
      peer: key,

      inbound: { startedAt: ts, bytes: 0 },
      outbound: { startedAt: ts, bytes: 0 },

      inboundAllowed: 0,
      outboundAllowed: 0,

      inboundRejected: 0,
      outboundRejected: 0,

      inboundBytesAllowed: 0,
      outboundBytesAllowed: 0,

      inboundBytesRejected: 0,
      outboundBytesRejected: 0,

      lastInboundAt: 0,
      lastOutboundAt: 0,
      lastRejectAt: 0,
      lastRejectReason: null,
    };

    this.peers.set(key, state);
    return state;
  }

  allowInbound(peer: string, bytes: number): BandwidthThrottleDecision {
    return this.allow(peer, "inbound", bytes);
  }

  allowOutbound(peer: string, bytes: number): BandwidthThrottleDecision {
    return this.allow(peer, "outbound", bytes);
  }

  allow(peer: string, direction: BandwidthDirection, bytesRaw: number): BandwidthThrottleDecision {
    const bytes = cleanBytes(bytesRaw);
    const state = this.getOrCreate(peer);
    const ts = now();
    const window = direction === "inbound" ? state.inbound : state.outbound;
    const limitBytes = direction === "inbound" ? this.inboundLimitBytes : this.outboundLimitBytes;

    this.rollWindow(window, ts);

    if (!this.enabled) {
      this.recordAllowed(state, direction, bytes, ts);
      return this.decision(true, state.peer, direction, bytes, window, limitBytes, ts);
    }

    if (bytes > limitBytes) {
      const reason = `single-message-over-limit bytes=${bytes} limit=${limitBytes}`;
      this.recordRejected(state, direction, bytes, ts, reason);
      return this.decision(false, state.peer, direction, bytes, window, limitBytes, ts, reason);
    }

    if (window.bytes + bytes > limitBytes) {
      const reason = `window-over-limit used=${window.bytes} bytes=${bytes} limit=${limitBytes}`;
      this.recordRejected(state, direction, bytes, ts, reason);
      return this.decision(false, state.peer, direction, bytes, window, limitBytes, ts, reason);
    }

    window.bytes += bytes;
    this.recordAllowed(state, direction, bytes, ts);
    return this.decision(true, state.peer, direction, bytes, window, limitBytes, ts);
  }

  snapshot(peer: string): BandwidthPeerSnapshot {
    const state = this.getOrCreate(peer);
    const ts = now();

    this.rollWindow(state.inbound, ts);
    this.rollWindow(state.outbound, ts);

    return {
      peer: state.peer,

      inboundWindowBytes: state.inbound.bytes,
      outboundWindowBytes: state.outbound.bytes,

      inboundLimitBytes: this.inboundLimitBytes,
      outboundLimitBytes: this.outboundLimitBytes,

      inboundWindowStartedAt: state.inbound.startedAt,
      outboundWindowStartedAt: state.outbound.startedAt,

      inboundResetInMs: Math.max(0, this.windowMs - (ts - state.inbound.startedAt)),
      outboundResetInMs: Math.max(0, this.windowMs - (ts - state.outbound.startedAt)),

      inboundAllowed: state.inboundAllowed,
      outboundAllowed: state.outboundAllowed,

      inboundRejected: state.inboundRejected,
      outboundRejected: state.outboundRejected,

      inboundBytesAllowed: state.inboundBytesAllowed,
      outboundBytesAllowed: state.outboundBytesAllowed,

      inboundBytesRejected: state.inboundBytesRejected,
      outboundBytesRejected: state.outboundBytesRejected,

      lastInboundAt: state.lastInboundAt,
      lastOutboundAt: state.lastOutboundAt,
      lastRejectAt: state.lastRejectAt,
      lastRejectReason: state.lastRejectReason,
    };
  }

  summary(): BandwidthThrottleSummary {
    const peers = Array.from(this.peers.keys())
      .map((peer) => this.snapshot(peer))
      .sort((a, b) => {
        const aRejected = a.inboundRejected + a.outboundRejected;
        const bRejected = b.inboundRejected + b.outboundRejected;
        if (aRejected !== bRejected) return bRejected - aRejected;

        const aBytes = a.inboundWindowBytes + a.outboundWindowBytes;
        const bBytes = b.inboundWindowBytes + b.outboundWindowBytes;
        return bBytes - aBytes;
      });

    return {
      enabled: this.enabled,
      windowMs: this.windowMs,
      inboundLimitBytes: this.inboundLimitBytes,
      outboundLimitBytes: this.outboundLimitBytes,
      trackedPeers: peers.length,

      totalInboundAllowed: peers.reduce((s, p) => s + p.inboundAllowed, 0),
      totalOutboundAllowed: peers.reduce((s, p) => s + p.outboundAllowed, 0),
      totalInboundRejected: peers.reduce((s, p) => s + p.inboundRejected, 0),
      totalOutboundRejected: peers.reduce((s, p) => s + p.outboundRejected, 0),

      totalInboundBytesAllowed: peers.reduce((s, p) => s + p.inboundBytesAllowed, 0),
      totalOutboundBytesAllowed: peers.reduce((s, p) => s + p.outboundBytesAllowed, 0),
      totalInboundBytesRejected: peers.reduce((s, p) => s + p.inboundBytesRejected, 0),
      totalOutboundBytesRejected: peers.reduce((s, p) => s + p.outboundBytesRejected, 0),

      peers,
    };
  }

  clearPeer(peer: string) {
    this.peers.delete(cleanPeer(peer));
  }

  clearAll() {
    this.peers.clear();
  }

  private rollWindow(window: BandwidthWindow, ts: number) {
    if (ts - window.startedAt < this.windowMs) return;
    window.startedAt = ts;
    window.bytes = 0;
  }

  private recordAllowed(state: BandwidthPeerState, direction: BandwidthDirection, bytes: number, ts: number) {
    if (direction === "inbound") {
      state.inboundAllowed++;
      state.inboundBytesAllowed += bytes;
      state.lastInboundAt = ts;
      return;
    }

    state.outboundAllowed++;
    state.outboundBytesAllowed += bytes;
    state.lastOutboundAt = ts;
  }

  private recordRejected(
    state: BandwidthPeerState,
    direction: BandwidthDirection,
    bytes: number,
    ts: number,
    reason: string
  ) {
    if (direction === "inbound") {
      state.inboundRejected++;
      state.inboundBytesRejected += bytes;
    } else {
      state.outboundRejected++;
      state.outboundBytesRejected += bytes;
    }

    state.lastRejectAt = ts;
    state.lastRejectReason = reason;
  }

  private decision(
    allowed: boolean,
    peer: string,
    direction: BandwidthDirection,
    bytes: number,
    window: BandwidthWindow,
    limitBytes: number,
    ts: number,
    reason?: string
  ): BandwidthThrottleDecision {
    return {
      allowed,
      peer,
      direction,
      bytes,
      usedBytes: window.bytes,
      limitBytes,
      windowStartedAt: window.startedAt,
      windowMs: this.windowMs,
      resetInMs: Math.max(0, this.windowMs - (ts - window.startedAt)),
      reason,
    };
  }
}

export const bandwidthThrottle = new BandwidthThrottleBook({
  enabled: true,
  windowMs: DEFAULT_WINDOW_MS,
  inboundLimitBytes: DEFAULT_INBOUND_LIMIT_BYTES,
  outboundLimitBytes: DEFAULT_OUTBOUND_LIMIT_BYTES,
});

export function getBandwidthThrottleStats() {
  return bandwidthThrottle.summary();
}
