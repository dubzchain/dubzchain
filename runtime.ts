// runtime.ts
import * as fs from "fs";
import { URL } from "url";
import { collectPublicSeeds, getPublicSeedStats, type PublicSeedPeer } from "./public-seeds";

export type BootstrapPlan = {
  port: number;
  host: string;
  rpcHost: string;
  advertise: string | null;
  peers: string[];
  bootstrapOnly: boolean;
  bootstrapWaitMs: number;
  publicSeeds?: PublicSeedPeer[];
};

export function argValue(argv: string[], flag: string) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return null;
}

export function argHas(argv: string[], flag: string) {
  return argv.includes(flag);
}

export function collectFlagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out.push(argv[i + 1]);
    }
  }
  return out;
}

export function normalizeWsUrl(raw: string): string | null {
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

export function loadBootstrapFile(path: string | null): string[] {
  if (!path) return [];
  try {
    const raw = fs.readFileSync(path, "utf8");
    return raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => !!x && !x.startsWith("#"));
  } catch {
    return [];
  }
}

export function collectBootstrapPeers(args: {
  argv: string[];
  positionalPeerUrl: string | null;
}): string[] {
  const raw: string[] = [];

  if (args.positionalPeerUrl) raw.push(args.positionalPeerUrl);

  // Support --bootstrap, legacy/test-instruction alias --peer, and both ws:// + wss://.
  raw.push(...collectFlagValues(args.argv, "--bootstrap"));
  raw.push(...collectFlagValues(args.argv, "--peer"));

  raw.push(...loadBootstrapFile(argValue(args.argv, "--bootstrap-file")));

  const publicSeeds = collectPublicSeeds({ argv: args.argv });
  for (const seed of publicSeeds) raw.push(seed.url);

  const seen = new Set<string>();
  const out: string[] = [];

  for (const v of raw) {
    const n = normalizeWsUrl(v);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }

  return out;
}

export async function connectBootstrapPeers(
  peers: string[],
  connectToPeer: (peer: string, onReady?: () => void) => any
): Promise<number> {
  let started = 0;
  for (const peer of peers) {
    const ws = connectToPeer(peer, () => {
      console.log(`🌱 Bootstrap connected ${peer}`);
    });
    if (ws) started++;
  }
  return started;
}

export function printBootstrapPlan(opts: BootstrapPlan) {
  console.log("🧭 Bootstrap workflow");
  console.log(`   nodePort=${opts.port}`);
  console.log(`   p2pHost=${opts.host}`);
  console.log(`   rpcHost=${opts.rpcHost}`);
  console.log(`   advertise=${opts.advertise ?? "(none)"}`);
  console.log(`   bootstrapPeers=${opts.peers.length}`);
  for (const p of opts.peers) console.log(`   - ${p}`);
  console.log(`   bootstrapOnly=${opts.bootstrapOnly}`);
  console.log(`   bootstrapWaitMs=${opts.bootstrapWaitMs}`);
  const seedStats = getPublicSeedStats();
  console.log(`   publicSeedsEnabled=${seedStats.enabled}`);
  console.log(`   publicSeeds=${seedStats.totalSeedCount}`);
  for (const s of seedStats.seeds) console.log(`   seed(${s.source}) ${s.url}`);
}

export function usage() {
  console.log(`
Usage:
  node index.js <port> [peerUrl]

Flags:
  --host <host>
  --rpc-host <host>
  --advertise <ws://host:port | wss://host:port>
  --bootstrap <ws://host:port | wss://host:port>      (repeatable)
  --peer <ws://host:port | wss://host:port>           (alias of --bootstrap)
  --bootstrap-file <path>
  --seed <ws://host:port | wss://host:port>           (repeatable public seed)
  --public-seed <ws://host:port | wss://host:port>    (alias of --seed)
  --seed-file <path>                                  (public seed list)
  --public-seeds / --no-public-seeds
  --no-default-public-seeds
  --bootstrap-only
  --bootstrap-wait-ms <ms>
  --balance
  --send <walletFile> <amount>
  --automine
  --mine-empty
  --mine-interval <ms>
  --mine-yield <nonces>
  --proof-balance [walletFile]
  --proof-nonce [walletFile]
  --proof-pending [walletFile] [index]
  --proof-minted
  --p2p-proof-minted <ws://peer | wss://peer>
  --p2p-proof-balance <ws://peer | wss://peer> [walletFile]
  --p2p-proof-nonce <ws://peer | wss://peer> [walletFile]
  --p2p-proof-pending <ws://peer | wss://peer> [walletFile] [index]

TLS / secure websocket env:
  DUBZ_P2P_TLS=true
  DUBZ_P2P_TLS_CERT=certs/node.crt
  DUBZ_P2P_TLS_KEY=certs/node.key
  DUBZ_P2P_TLS_REJECT_UNAUTHORIZED=false

Examples:
  node dist/index.js 3001 --host 0.0.0.0 --rpc-host 0.0.0.0 --advertise ws://192.168.1.100:3001 --automine --mine-empty
  node dist/index.js 3001 --host 0.0.0.0 --rpc-host 0.0.0.0 --advertise wss://192.168.1.100:3001 --automine --mine-empty
  node dist/index.js 3002 --bootstrap ws://192.168.1.100:3001 --automine --mine-empty
  node dist/index.js 3002 --peer wss://192.168.1.100:3001 --automine --mine-empty
  node dist/index.js 3003 --bootstrap-file bootstrap.txt --bootstrap-wait-ms 8000 --automine --mine-empty
  node dist/index.js 3004 --public-seed wss://seed1.dubzchain.net:3001 --bootstrap-wait-ms 8000 --automine --mine-empty
`);
}
