# DubzChain Node Operator Guide

## Overview

This guide explains how to operate a DubzChain public testnet node.

Supported modes:

- public seed node
- standard peer node
- mining node
- archival node
- pruned node

---

# 1. Install

Install dependencies:

```bash
npm install

Compile:
npx tsc

2. Public Testnet Identity

chainId: dubzchain-testnet
reward: 3 DUBZ
maxSupply: 33,000,000
targetBlockTime: 21 seconds

Genesis:

7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff

3. Start Standard Node

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0

4. Start Mining Node

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --automine \
  --mine-empty

5. Connect To Existing Peer

node dist/index.js 3102 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --peer ws://SEED_NODE_IP:3101

6. Public Seed Node

Example:

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --advertise wss://seed1.dubzchain.net:3101

7. TLS / Secure Websocket

Environment variables:

DUBZ_P2P_TLS_CERT
DUBZ_P2P_TLS_KEY

Recommended:

Let's Encrypt certificates
8. RPC Authentication

Environment variable:

DUBZ_RPC_API_KEY

Example:

export DUBZ_RPC_API_KEY=my-testnet-key
9. Storage Modes
Archival

Stores full chain history.

DUBZ_STORAGE_MODE=archival
Pruned

Stores recent chain history only.

DUBZ_STORAGE_MODE=pruned

10. Check Node Status
/status
/health
/peers
/sync
/storage

Example:

http://127.0.0.1:4101/status

11. Replay Validation
/debug/replay-verify

12. Genesis Validation
/debug/block-validate?height=0

Expected genesis:

7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff

13. Metrics / Telemetry

Endpoints:

/metrics
/telemetry

14. Peer Sync Expectations

Healthy node:

syncProgressPct: 100
syncLagBlocks: 0

15. Crash Recovery

DubzChain supports:

crash journals
chain auto-repair
snapshot recovery
replay validation

16. Public Testnet Ports

Recommended:

P2P: 3101
RPC: 4101

17. Devnet vs Testnet

Devnet:

chainId: dubzchain-devnet
ports: 3001+

Public testnet:

chainId: dubzchain-testnet
ports: 3101+

Never mix devnet chain files with testnet chain files.

18. Recommended Hardware

Minimum:

2 CPU
4GB RAM
20GB SSD

Recommended:

4 CPU
8GB RAM
100GB SSD

19. Public Launch Notes

Before public launch:

verify genesis hash
verify state root
verify seed nodes
verify checkpoint signing
complete attack suite
complete soak testing

Then run:

```bash
ls OPERATOR_GUIDE.md