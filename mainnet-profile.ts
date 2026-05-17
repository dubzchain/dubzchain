// mainnet-profile.ts

/* =========================
   Network Configuration Profiles
   Phase 10.1 — Frozen Public Testnet Constants
========================= */

export type DubzNetworkProfileName = "devnet" | "testnet" | "mainnet";

export type DubzDifficultyProfile = {
  minDifficulty: number;
  maxDifficulty: number;
  targetBlockMs: number;
  diffWindow: number;
};

export type DubzMonetaryProfile = {
  maxSupply: number;
  initialReward: number;
  halvingInterval: number;
  coinbaseMaturity: number;
  minFee: number;
};

export type DubzBlockPolicyProfile = {
  maxBlockBytes: number;
  maxTxPerBlock: number;
  maxMempoolTxs: number;
  maxMempoolTxsPerSender: number;
  defaultMinRelayFee: number;
};

export type DubzStorageProfile = {
  defaultStorageMode: "archival" | "pruned";
  pruneEnabled: boolean;
  archivalMode: boolean;
  retentionWindow: number;
  checkpointEvery: number;
  snapshotEvery: number;
};

export type DubzNetworkPolicyProfile = {
  networkMagic: number;
  chainId: string;
  protocolVersion: number;
  defaultP2pPort: number;
  defaultRpcPort: number;
  maxMessageBytes: number;
  rateWindowMs: number;
  rateLimitCount: number;
  maxInboundPerIp: number;
  peerTableMax: number;
  requestChunkSize: number;
  initialBlockDownloadMaxChunkSize: number;
};

export type DubzSecurityProfile = {
  rpcAuthRequired: boolean;
  tlsRequired: boolean;
  publicSeedsRequired: boolean;
  checkpointSigningRequired: boolean;
  allowSelfSignedLocalTls: boolean;
};

export type DubzExplorerProfile = {
  explorerPublicMode: boolean;
  publicUrl: string | null;
  corsEnabled: boolean;
  robotsPolicy: "noindex,nofollow" | "index,follow";
  securityHeadersEnabled: boolean;
};

export type DubzGenesisProfile = {
  frozen: boolean;
  genesisTs: number;
  genesisNonce: number;
  genesisDifficulty: number;
  genesisHash: string | null;
  genesisStateRoot: string | null;
  genesisMessage: string;
};

export type DubzCheckpointProfile = {
  checkpointPublicKey: string | null;
  checkpointPublicKeyFileEnv: string;
  checkpointPrivateKeyFileEnv: string;
};

export type DubzSeedProfile = {
  defaultPublicSeeds: string[];
  envSeedsName: string;
  envSeedFileName: string;
};

export type DubzMainnetProfile = {
  name: DubzNetworkProfileName;
  description: string;
  production: boolean;
  createdAt: number;
  frozen: boolean;

  monetary: DubzMonetaryProfile;
  difficulty: DubzDifficultyProfile;
  blocks: DubzBlockPolicyProfile;
  storage: DubzStorageProfile;
  network: DubzNetworkPolicyProfile;
  security: DubzSecurityProfile;
  explorer: DubzExplorerProfile;
  genesis: DubzGenesisProfile;
  checkpoints: DubzCheckpointProfile;
  seeds: DubzSeedProfile;

  notes: string[];
};

export type DubzMainnetProfileSummary = {
  activeProfile: DubzNetworkProfileName;
  production: boolean;
  frozen: boolean;
  chainId: string;
  networkMagicHex: string;
  protocolVersion: number;
  defaultP2pPort: number;
  defaultRpcPort: number;
  maxSupply: number;
  initialReward: number;
  halvingInterval: number;
  coinbaseMaturity: number;
  minDifficulty: number;
  maxDifficulty: number;
  targetBlockMs: number;
  storageMode: "archival" | "pruned";
  genesisFrozen: boolean;
  genesisTs: number;
  genesisDifficulty: number;
  genesisHash: string | null;
  checkpointPublicKeySet: boolean;
  defaultPublicSeeds: string[];
  rpcAuthRequired: boolean;
  tlsRequired: boolean;
  publicSeedsRequired: boolean;
  checkpointSigningRequired: boolean;
  explorerPublicMode: boolean;
  warnings: string[];
};

const CREATED_AT = 1778440000000;

export const DEVNET_PROFILE: DubzMainnetProfile = {
  name: "devnet",
  description: "Local development profile for fast testing and iterative DubzChain development.",
  production: false,
  createdAt: CREATED_AT,
  frozen: false,

  monetary: {
    maxSupply: 33_000_000,
    initialReward: 33,
    halvingInterval: 515_625,
    coinbaseMaturity: 33,
    minFee: 1,
  },

  difficulty: {
    minDifficulty: 2,
    maxDifficulty: 6,
    targetBlockMs: 21_000,
    diffWindow: 120,
  },

  blocks: {
    maxBlockBytes: 250_000,
    maxTxPerBlock: 5_000,
    maxMempoolTxs: 10_000,
    maxMempoolTxsPerSender: 128,
    defaultMinRelayFee: 2,
  },

  storage: {
    defaultStorageMode: "archival",
    pruneEnabled: false,
    archivalMode: true,
    retentionWindow: 288,
    checkpointEvery: 50,
    snapshotEvery: 50,
  },

  network: {
    networkMagic: 0xd00b2c01,
    chainId: "dubzchain-devnet",
    protocolVersion: 1,
    defaultP2pPort: 3001,
    defaultRpcPort: 4001,
    maxMessageBytes: 2_000_000,
    rateWindowMs: 10_000,
    rateLimitCount: 250,
    maxInboundPerIp: 20,
    peerTableMax: 64,
    requestChunkSize: 32,
    initialBlockDownloadMaxChunkSize: 128,
  },

  security: {
    rpcAuthRequired: false,
    tlsRequired: false,
    publicSeedsRequired: false,
    checkpointSigningRequired: false,
    allowSelfSignedLocalTls: true,
  },

  explorer: {
    explorerPublicMode: false,
    publicUrl: null,
    corsEnabled: false,
    robotsPolicy: "noindex,nofollow",
    securityHeadersEnabled: true,
  },

  genesis: {
    frozen: false,
    genesisTs: 1700000000000,
    genesisNonce: 0,
    genesisDifficulty: 2,
    genesisHash: null,
    genesisStateRoot: null,
    genesisMessage: "DubzChain devnet genesis",
  },

  checkpoints: {
    checkpointPublicKey: null,
    checkpointPublicKeyFileEnv: "DUBZ_CHECKPOINT_PUBLIC_KEY_FILE",
    checkpointPrivateKeyFileEnv: "DUBZ_CHECKPOINT_PRIVATE_KEY_FILE",
  },

  seeds: {
    defaultPublicSeeds: [],
    envSeedsName: "DUBZ_PUBLIC_SEEDS",
    envSeedFileName: "DUBZ_PUBLIC_SEED_FILE",
  },

  notes: [
    "Devnet allows local-only operation without RPC auth.",
    "Devnet allows ws:// and self-signed wss:// testing.",
    "Devnet is not intended for production value transfer.",
  ],
};

export const TESTNET_PROFILE: DubzMainnetProfile = {
  ...DEVNET_PROFILE,
  name: "testnet",
  description: "Frozen public testnet profile for DubzChain public launch validation.",
  production: false,
  frozen: true,

  monetary: {
    maxSupply: 33_000_000,
    initialReward: 33,
    halvingInterval: 515_625,
    coinbaseMaturity: 33,
    minFee: 1,
  },

  difficulty: {
    minDifficulty: 3,
    maxDifficulty: 6,
    targetBlockMs: 190_000,
    diffWindow: 120,
  },

  blocks: {
    maxBlockBytes: 250_000,
    maxTxPerBlock: 5_000,
    maxMempoolTxs: 10_000,
    maxMempoolTxsPerSender: 128,
    defaultMinRelayFee: 2,
  },

  network: {
    networkMagic: 0xd00b2c02,
    chainId: "dubzchain-testnet",
    protocolVersion: 1,
    defaultP2pPort: 3101,
    defaultRpcPort: 4101,
    maxMessageBytes: 2_000_000,
    rateWindowMs: 10_000,
    rateLimitCount: 220,
    maxInboundPerIp: 12,
    peerTableMax: 64,
    requestChunkSize: 32,
    initialBlockDownloadMaxChunkSize: 128,
  },

  storage: {
    defaultStorageMode: "pruned",
    pruneEnabled: true,
    archivalMode: false,
    retentionWindow: 2_016,
    checkpointEvery: 50,
    snapshotEvery: 50,
  },

  security: {
    rpcAuthRequired: true,
    tlsRequired: true,
    publicSeedsRequired: true,
    checkpointSigningRequired: true,
    allowSelfSignedLocalTls: false,
  },

  explorer: {
    explorerPublicMode: true,
    publicUrl: null,
    corsEnabled: true,
    robotsPolicy: "noindex,nofollow",
    securityHeadersEnabled: true,
  },

  genesis: {
    frozen: true,
    genesisTs: 1700000000000,
    genesisNonce: 0,
    genesisDifficulty: 3,
    genesisHash: "7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff",
    genesisStateRoot: "779a8e3120016ea09c16e38e20404d493efef8c0001b57970959be136d39fdd6",
    genesisMessage: "DubzChain public testnet genesis — 33M supply, 33 reward",
  },

  checkpoints: {
    checkpointPublicKey: null,
    checkpointPublicKeyFileEnv: "DUBZ_CHECKPOINT_PUBLIC_KEY_FILE",
    checkpointPrivateKeyFileEnv: "DUBZ_CHECKPOINT_PRIVATE_KEY_FILE",
  },

  seeds: {
    defaultPublicSeeds: [],
    envSeedsName: "DUBZ_PUBLIC_SEEDS",
    envSeedFileName: "DUBZ_PUBLIC_SEED_FILE",
  },

  notes: [
    "PHASE 10.1 FROZEN TESTNET CONSTANTS.",
  "Testnet monetary identity is 33,000,000 max supply with 33 DUBZ initial reward.",
  "Testnet target block time is 190 seconds.",
  "Testnet coinbase maturity is 33 blocks.",
  "Testnet genesis hash and state root are finalized for v0.1.0-testnet.",
  "Testnet public seed URLs remain empty until public VPS deployment.",
  "Testnet checkpoint public key remains null until real checkpoint key generation.",
  "This profile is for public testnet only. Mainnet is not live.",
  ],
};

export const MAINNET_PROFILE: DubzMainnetProfile = {
  ...TESTNET_PROFILE,
  name: "mainnet",
  description: "Production mainnet readiness profile for DubzChain.",
  production: true,
  frozen: false,

  network: {
    ...TESTNET_PROFILE.network,
    chainId: "dubzchain-mainnet",
    networkMagic: 0xd00b2c03,
    defaultP2pPort: 3333,
    defaultRpcPort: 4333,
    rateLimitCount: 180,
    maxInboundPerIp: 8,
    requestChunkSize: 64,
    initialBlockDownloadMaxChunkSize: 128,
  },

  storage: {
    ...TESTNET_PROFILE.storage,
    defaultStorageMode: "pruned",
    pruneEnabled: true,
    archivalMode: false,
    retentionWindow: 10_080,
    checkpointEvery: 50,
    snapshotEvery: 50,
  },

  genesis: {
    frozen: false,
    genesisTs: 0,
    genesisNonce: 0,
    genesisDifficulty: 3,
    genesisHash: null,
    genesisStateRoot: null,
    genesisMessage: "DubzChain mainnet genesis — pending finalization",
  },

  security: {
    rpcAuthRequired: true,
    tlsRequired: true,
    publicSeedsRequired: true,
    checkpointSigningRequired: true,
    allowSelfSignedLocalTls: false,
  },

  explorer: {
    explorerPublicMode: true,
    publicUrl: null,
    corsEnabled: true,
    robotsPolicy: "index,follow",
    securityHeadersEnabled: true,
  },

  notes: [
    "Mainnet profile is not frozen yet.",
    "Do not launch mainnet until public testnet launch, attack suite, soak test, and release validation pass.",
    "Mainnet ports are intentionally separated from local devnet and public testnet ports.",
  ],
};

export const NETWORK_PROFILES: Record<DubzNetworkProfileName, DubzMainnetProfile> = {
  devnet: DEVNET_PROFILE,
  testnet: TESTNET_PROFILE,
  mainnet: MAINNET_PROFILE,
};

function env(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function normalizeProfileName(raw?: string | null): DubzNetworkProfileName {
  const value = String(raw || "").trim().toLowerCase();

  if (value === "mainnet") return "mainnet";
  if (value === "testnet") return "testnet";
  return "devnet";
}

export function getActiveNetworkProfile(argv: string[] = process.argv): DubzMainnetProfile {
  const flagIndex = argv.indexOf("--profile");
  const flagValue = flagIndex >= 0 ? argv[flagIndex + 1] : null;
  const envValue = env("DUBZ_NETWORK_PROFILE") || env("DUBZ_PROFILE");

  const name = normalizeProfileName(flagValue || envValue);
  return NETWORK_PROFILES[name];
}

export function profileWarnings(profile: DubzMainnetProfile): string[] {
  const warnings: string[] = [];

  if (profile.name === "testnet") {
    if (!profile.genesis.genesisHash) {
      warnings.push("Testnet genesis hash is not finalized yet. Complete Phase 10.2.");
    }

    if (!profile.genesis.genesisStateRoot) {
      warnings.push("Testnet genesis state root is not finalized yet. Complete Phase 10.2.");
    }

    if (!profile.checkpoints.checkpointPublicKey && !env(profile.checkpoints.checkpointPublicKeyFileEnv)) {
      warnings.push("Testnet checkpoint public key is not set yet.");
    }

    if (profile.seeds.defaultPublicSeeds.length === 0 && !env(profile.seeds.envSeedsName) && !env(profile.seeds.envSeedFileName)) {
      warnings.push("Testnet public seed URLs are not set yet.");
    }
  }

  if (profile.name === "mainnet") {
    if (!env("DUBZ_RPC_API_KEY") && !env("DUBZ_RPC_API_KEYS")) {
      warnings.push("Mainnet profile expects DUBZ_RPC_API_KEY or DUBZ_RPC_API_KEYS.");
    }

    if (!env("DUBZ_P2P_TLS_CERT") || !env("DUBZ_P2P_TLS_KEY")) {
      warnings.push("Mainnet profile expects DUBZ_P2P_TLS_CERT and DUBZ_P2P_TLS_KEY.");
    }

    if (!env(profile.checkpoints.checkpointPrivateKeyFileEnv) || !env(profile.checkpoints.checkpointPublicKeyFileEnv)) {
      warnings.push("Mainnet profile expects checkpoint signing key files.");
    }

    if (!env(profile.seeds.envSeedsName) && !env(profile.seeds.envSeedFileName)) {
      warnings.push("Mainnet profile expects public seeds.");
    }

    if (!env("DUBZ_EXPLORER_PUBLIC_URL")) {
      warnings.push("Mainnet public explorer should define DUBZ_EXPLORER_PUBLIC_URL.");
    }
  }

  if (profile.production && profile.security.allowSelfSignedLocalTls) {
    warnings.push("Production profile should not allow self-signed local TLS.");
  }

  return warnings;
}

export function summarizeNetworkProfile(profile: DubzMainnetProfile): DubzMainnetProfileSummary {
  return {
    activeProfile: profile.name,
    production: profile.production,
    frozen: profile.frozen,
    chainId: profile.network.chainId,
    networkMagicHex: "0x" + profile.network.networkMagic.toString(16),
    protocolVersion: profile.network.protocolVersion,
    defaultP2pPort: profile.network.defaultP2pPort,
    defaultRpcPort: profile.network.defaultRpcPort,
    maxSupply: profile.monetary.maxSupply,
    initialReward: profile.monetary.initialReward,
    halvingInterval: profile.monetary.halvingInterval,
    coinbaseMaturity: profile.monetary.coinbaseMaturity,
    minDifficulty: profile.difficulty.minDifficulty,
    maxDifficulty: profile.difficulty.maxDifficulty,
    targetBlockMs: profile.difficulty.targetBlockMs,
    storageMode: profile.storage.defaultStorageMode,
    genesisFrozen: profile.genesis.frozen,
    genesisTs: profile.genesis.genesisTs,
    genesisDifficulty: profile.genesis.genesisDifficulty,
    genesisHash: profile.genesis.genesisHash,
    checkpointPublicKeySet: !!profile.checkpoints.checkpointPublicKey,
    defaultPublicSeeds: profile.seeds.defaultPublicSeeds,
    rpcAuthRequired: profile.security.rpcAuthRequired,
    tlsRequired: profile.security.tlsRequired,
    publicSeedsRequired: profile.security.publicSeedsRequired,
    checkpointSigningRequired: profile.security.checkpointSigningRequired,
    explorerPublicMode: profile.explorer.explorerPublicMode,
    warnings: profileWarnings(profile),
  };
}

export function printNetworkProfile(profile: DubzMainnetProfile) {
  const s = summarizeNetworkProfile(profile);

  console.log("🧬 DubzChain network profile");
  console.log(`   profile=${s.activeProfile}`);
  console.log(`   production=${s.production}`);
  console.log(`   frozen=${s.frozen}`);
  console.log(`   chainId=${s.chainId}`);
  console.log(`   magic=${s.networkMagicHex}`);
  console.log(`   protocolVersion=${s.protocolVersion}`);
  console.log(`   defaultP2pPort=${s.defaultP2pPort}`);
  console.log(`   defaultRpcPort=${s.defaultRpcPort}`);
  console.log(`   maxSupply=${s.maxSupply}`);
  console.log(`   initialReward=${s.initialReward}`);
  console.log(`   halvingInterval=${s.halvingInterval}`);
  console.log(`   coinbaseMaturity=${s.coinbaseMaturity}`);
  console.log(`   targetBlockMs=${s.targetBlockMs}`);
  console.log(`   storageMode=${s.storageMode}`);
  console.log(`   genesisFrozen=${s.genesisFrozen}`);
  console.log(`   genesisTs=${s.genesisTs}`);
  console.log(`   genesisDifficulty=${s.genesisDifficulty}`);
  console.log(`   genesisHash=${s.genesisHash || "(pending)"}`);
  console.log(`   checkpointPublicKeySet=${s.checkpointPublicKeySet}`);
  console.log(`   publicSeeds=${s.defaultPublicSeeds.length}`);
  console.log(`   rpcAuthRequired=${s.rpcAuthRequired}`);
  console.log(`   tlsRequired=${s.tlsRequired}`);
  console.log(`   publicSeedsRequired=${s.publicSeedsRequired}`);
  console.log(`   checkpointSigningRequired=${s.checkpointSigningRequired}`);

  for (const warning of s.warnings) {
    console.log(`   ⚠️ ${warning}`);
  }
}

export function exportNetworkProfileJson(profile: DubzMainnetProfile) {
  return {
    ok: true,
    profile,
    summary: summarizeNetworkProfile(profile),
  };
}