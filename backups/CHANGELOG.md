# DubzChain Changelog

## v0.1.0-testnet

Public testnet release candidate.

### Status

```text
Release type: Public testnet package
Network: dubzchain-testnet
Status: Release candidate

Network Identity
chainId: dubzchain-testnet
protocolVersion: 1
networkMagic: 0xd00b2c02
initialReward: 33 DUBZ
maxSupply: 33,000,000 DUBZ
halvingInterval: 515,625 blocks
coinbaseMaturity: 33 blocks

Core Blockchain
Added / completed:
Proof-of-work mining
Deterministic genesis
Block validation
Replay validation
Most-work chain selection
Signed transactions
Nonce protection
Fee validation
Mempool
Coinbase maturity
Max supply enforcement
Merkle transaction root
State root commitments
State proof generation
State proof verification

Networking
Added / completed:
P2P websocket network
Peer connections
Peer reconnect / retry / backoff
Headers exchange
Block range sync
Peer discovery
Persistent peer table
Orphan block handling
Compact block propagation
Transaction gossip
Mempool request / response
Message compression
Snapshot sync

Node Operations
Added / completed:
RPC server
Explorer
Health endpoint
Status endpoint
Peer endpoint
Sync endpoint
Storage endpoint
Diagnostics endpoint
Network diagnostics
Metrics endpoint
Telemetry endpoint
Wallet lookup
Wallet resolve
Wallet send validation
Send history
Replay verify endpoint
Block validation endpoint
State-root check endpoint

Production Infrastructure
Added / completed:
Profile-driven devnet / testnet / mainnet configuration
Public testnet profile
RPC auth support
TLS / secure websocket support
Public seed support
Checkpoint signing support
Bandwidth throttling
Peer reputation scoring
Peer banning and decay
Crash recovery journal
Chain auto-repair
Separated chainstate storage
Async disk write queue
Archival / pruned storage modes
Benchmark support
Deployment diagnostics

Public Testnet Launch Package
Added:
README.md
env.example
OPERATOR_GUIDE.md
SEED_NODE_GUIDE.md
EXPLORER_DEPLOYMENT_GUIDE.md
PUBLIC_TESTNET_COMMANDS.md
ANDROID_TERMUX_MINING_GUIDE.md
CHANGELOG.md

Validation Passed
2-node sync test passed
3-node sync test passed
Android / Termux miner test passed
Mac + Android peer mining test passed
Formal attack suite passed
Long soak test passed

Validation Passed
2-node sync test passed
3-node sync test passed
Android / Termux miner test passed
Mac + Android peer mining test passed
Formal attack suite passed
Long soak test passed

Known Notes
This is a public testnet release candidate.
Do not treat testnet DUBZ as mainnet value.
Mainnet genesis is not finalized.
Public seed URLs are placeholders until deployment.
Checkpoint keys must be finalized before public launch.

Next Steps
10.14 Tag release version
10.15 Public testnet go/no-go checklist
10.16 Public testnet launch report
Public seed node deployment
Public explorer deployment
GitHub release upload

