// public-seeds.ts
import * as fs from "fs";
import { URL } from "url";

/* =========================
   Public Seed Node Support
   Phase 9.14
========================= */

export type PublicSeedSource = "default" | "env" | "flag" | "file";

export type PublicSeedPeer = {
  url: string;
  source: PublicSeedSource;
};

export type PublicSeedStats = {
  enabled: boolean;
  defaultSeedsEnabled: boolean;
  defaultSeedCount: number;
  envSeedCount: number;
  flagSeedCount: number;
  fileSeedCount: number;
  totalSeedCount: number;
  seeds: PublicSeedPeer[];
};

export const DEFAULT_PUBLIC_SEEDS: string[] = [
  // Mainnet/public seed placeholders.
  // Replace these with real More Dubz seed nodes before public launch.
  "wss://seed1.dubzchain.net:3001",
  "wss://seed2.dubzchain.net:3001",
  "wss://seed3.dubzchain.net:3001",
];

function env(name: string) {
  return process.env[name] || "";
}

function boolEnv(name: string, defaultValue: boolean) {
  const v = env(name).trim().toLowerCase();
  if (!v) return defaultValue;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

export function normalizeSeedUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  try {
    const u = new URL(s);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    if (!u.hostname) return null;
    const secure = u.protocol === "wss:";
    const port = u.port || (secure ? "443" : "80");
    return `${secure ? "wss" : "ws"}://${u.hostname}:${port}`;
  } catch {
    return null;
  }
}

function splitSeedList(raw: string): string[] {
  return String(raw || "")
    .split(/[\s,]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function loadPublicSeedFile(path: string | null | undefined): string[] {
  if (!path) return [];

  try {
    const raw = fs.readFileSync(path, "utf8");
    return raw
      .split(/\r?\n/g)
      .map((x) => x.trim())
      .filter((x) => !!x && !x.startsWith("#"));
  } catch {
    return [];
  }
}

function dedupeSeeds(items: PublicSeedPeer[]): PublicSeedPeer[] {
  const seen = new Set<string>();
  const out: PublicSeedPeer[] = [];

  for (const item of items) {
    const n = normalizeSeedUrl(item.url);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ url: n, source: item.source });
  }

  return out;
}

export function publicSeedsEnabled(argv: string[] = process.argv): boolean {
  if (argv.includes("--no-public-seeds")) return false;
  if (argv.includes("--public-seeds")) return true;
  return boolEnv("DUBZ_PUBLIC_SEEDS_ENABLED", true);
}

export function defaultPublicSeedsEnabled(argv: string[] = process.argv): boolean {
  if (argv.includes("--no-default-public-seeds")) return false;
  return boolEnv("DUBZ_DEFAULT_PUBLIC_SEEDS_ENABLED", false);
}

function collectFlagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out.push(argv[i + 1]);
    }
  }

  return out;
}

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return null;
}

export function collectPublicSeeds(args: {
  argv?: string[];
  includeDefaults?: boolean;
  explicitSeeds?: string[];
  seedFile?: string | null;
} = {}): PublicSeedPeer[] {
  const argv = args.argv ?? process.argv;
  if (!publicSeedsEnabled(argv)) return [];

  const raw: PublicSeedPeer[] = [];

  const includeDefaults = args.includeDefaults ?? defaultPublicSeedsEnabled(argv);
  if (includeDefaults) {
    for (const seed of DEFAULT_PUBLIC_SEEDS) raw.push({ url: seed, source: "default" });
  }

  for (const seed of splitSeedList(env("DUBZ_PUBLIC_SEEDS"))) {
    raw.push({ url: seed, source: "env" });
  }

  for (const seed of collectFlagValues(argv, "--seed")) {
    raw.push({ url: seed, source: "flag" });
  }

  for (const seed of collectFlagValues(argv, "--public-seed")) {
    raw.push({ url: seed, source: "flag" });
  }

  for (const seed of args.explicitSeeds ?? []) {
    raw.push({ url: seed, source: "flag" });
  }

  const seedFile = args.seedFile ?? flagValue(argv, "--seed-file") ?? flagValue(argv, "--public-seed-file");
  for (const seed of loadPublicSeedFile(seedFile)) {
    raw.push({ url: seed, source: "file" });
  }

  return dedupeSeeds(raw);
}

export function getPublicSeedStats(argv: string[] = process.argv): PublicSeedStats {
  const enabled = publicSeedsEnabled(argv);
  const defaultEnabled = defaultPublicSeedsEnabled(argv);
  const seeds = collectPublicSeeds({ argv });

  return {
    enabled,
    defaultSeedsEnabled: defaultEnabled,
    defaultSeedCount: seeds.filter((s) => s.source === "default").length,
    envSeedCount: seeds.filter((s) => s.source === "env").length,
    flagSeedCount: seeds.filter((s) => s.source === "flag").length,
    fileSeedCount: seeds.filter((s) => s.source === "file").length,
    totalSeedCount: seeds.length,
    seeds,
  };
}
