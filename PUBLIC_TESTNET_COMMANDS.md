# DubzChain Public Testnet Commands

## Overview

This document contains standard launch commands for DubzChain public testnet operators.

Public testnet identity:

chainId: dubzchain-testnet
reward: 33 DUBZ
maxSupply: 33,000,000
targetBlockTime: 33 seconds

Genesis:
7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff

1. Compile
npx tsc

2. Start Standard Testnet Node

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0

3. Start Mining Node

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --automine \
  --mine-empty

4. Start Second Peer

node dist/index.js 3102 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --peer ws://127.0.0.1:3101

5. Start Public Seed Node

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --advertise wss://seed1.dubzchain.net:3101

6. Start Archival Node

DUBZ_STORAGE_MODE=archival \
node dist/index.js 3101 \
  --profile testnet

7. Start Pruned Node

DUBZ_STORAGE_MODE=pruned \
node dist/index.js 3101 \
  --profile testnet

8. Start Node With RPC Auth

DUBZ_RPC_API_KEY=my-testnet-key \
node dist/index.js 3101 \
  --profile testnet

9. Start TLS / Secure Websocket Node

DUBZ_P2P_TLS_CERT=./certs/fullchain.pem \
DUBZ_P2P_TLS_KEY=./certs/privkey.pem \
node dist/index.js 3101 \
  --profile testnet

10. Start Telemetry Node

DUBZ_TELEMETRY_ENABLED=true \
node dist/index.js 3101 \
  --profile testnet

11. Start Node With Public Seeds

DUBZ_PUBLIC_SEEDS=wss://seed1.dubzchain.net:3101,wss://seed2.dubzchain.net:3101 \
node dist/index.js 3101 \
  --profile testnet

12. Replay Verification

/debug/replay-verify

Example:

http://127.0.0.1:4101/debug/replay-verify

13. Genesis Validation

/debug/block-validate?height=0

Expected genesis:

7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff

14. Status Endpoint

http://127.0.0.1:4101/status

Healthy node:

syncProgressPct: 100
syncLagBlocks: 0

15. Explorer Endpoint

http://127.0.0.1:4101/index

16. Metrics Endpoint

http://127.0.0.1:4101/metrics

17. Telemetry Endpoint

http://127.0.0.1:4101/telemetry
18. Peer Endpoint

http://127.0.0.1:4101/peers

19. Sync Endpoint

http://127.0.0.1:4101/sync

20. Public Testnet Ports

Recommended:

P2P: 3101
RPC: 4101

Additional local peers:

3102 / 4102
3103 / 4103
3104 / 4104

21. Devnet Ports

3001 / 4001
3002 / 4002

22. Official Public Testnet Genesis

chainId:
dubzchain-testnet
genesisHash:
7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff
genesisStateRoot:
779a8e3120016ea09c16e38e20404d493efef8c0001b57970959be136d39fdd6

Then run:

ls PUBLIC_TESTNET_COMMANDS.md

# 23. Check Wallet Balance

Default miner wallet for port `3101`:


node dist/index.js 3101 \
  --profile testnet \
  --balance

Check another wallet file:

node dist/index.js 3101 \
  --profile testnet \
  --balance wallet.miner.3101.json

Balance output shows:

Spendable
Immature
Total
Nonce
Height
Supply
Reward now

Note:

Coinbase rewards mature after:

33 blocks

So newly mined rewards first appear as:

Immature

Then become spendable after 33 confirmations.

Also useful direct lookup endpoint:

http://127.0.0.1:4101/wallet/lookup?input=wallet.miner.3101.json