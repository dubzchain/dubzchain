# DubzChain v0.1.0-testnet

## Release Type
Public testnet release candidate.

## Summary
DubzChain v0.1.0-testnet is the first packaged public testnet release candidate for the DubzChain network.

This release includes the core blockchain engine, peer-to-peer networking, RPC/explorer access, wallet support, snapshot-assisted sync, public testnet profiles, security hardening, telemetry, release documentation, and local validation results.

## Testnet Identity
- chainId: dubzchain-testnet
- protocolVersion: 1
- networkMagic: 0xd00b2c02
- maxSupply: 33,000,000
- initialReward: 33
- halvingInterval: 515,625
- coinbaseMaturity: 33
- rewardNow: 33

## Mining / Difficulty Profile
- genesisDifficulty: 3
- minDifficulty: 3
- maxDifficulty: 6
- targetBlockMs: 190,000
- diffWindow: 120

## Completed
- Core proof-of-work blockchain engine
- Deterministic genesis
- Signed transactions
- Nonces, fees, mempool
- Merkle roots
- State root commitments
- State proof generation and verification
- Peer-to-peer networking
- Headers exchange
- Block range sync
- Peer discovery
- Persistent peer table
- Orphan handling
- RPC interface
- Wallet RPC
- Explorer
- Snapshot-assisted sync
- P2P snapshot request/response
- Compression
- Compact block propagation
- Mempool policy hardening
- Disk pruning
- Archival/pruned storage modes
- Peer reputation
- Advanced peer banning and decay
- Bandwidth throttling
- RPC auth / API key support
- TLS / secure websocket support
- Public seed support
- Bootstrap checkpoint signing support
- Metrics / telemetry
- Node benchmark suite
- Release candidate validation

## Validation
Passed:
- 2-node sync simulation
- 3-node sync simulation
- Android / Termux mining
- Mac + Android peer mining
- Formal local attack suite
- Long soak test

Attack tests passed:
- Invalid block test
- Bad signature test
- Double-spend test
- Bad nonce test
- Timestamp attack test
- Future timestamp attack test
- Orphan flood test
- Bad peer spam test
- Snapshot trust abuse test
- Corrupt file startup test

## Included Documentation
- README.md
- env.example
- OPERATOR_GUIDE.md
- SEED_NODE_GUIDE.md
- EXPLORER_DEPLOYMENT_GUIDE.md
- PUBLIC_TESTNET_COMMANDS.md
- ANDROID_TERMUX_MINING_GUIDE.md
- GO_NO_GO_CHECKLIST.md
- PUBLIC_TESTNET_LAUNCH_REPORT.md
- VERSION

## Package
- dubzchain-v0.1.0-testnet.zip

## Notes
This is a public testnet release candidate. Mainnet is not live.

The next major step is public internet deployment:
- VPS seed node
- Public explorer
- Real seed URLs
- TLS/wss configuration
- Mac + Android + VPS mixed-node test
- Fresh-machine public sync test
