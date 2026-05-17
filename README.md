# DubzChain

DubzChain is a proof-of-work blockchain built for the More Dubz ecosystem.

## Public Testnet

Current testnet identity:

```text
chainId: dubzchain-testnet
reward: 3 DUBZ
maxSupply: 33,000,000
targetBlockTime: 21 seconds
genesisHash: 7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff

Requirements
node -v
npm -v

Recommended:
Node.js 20+
npm 10+

Install:
npm install

Compile:
npx tsc

Run Public Testnet Node :
node dist/index.js 3101 \
  --profile testnet \
  --host 127.0.0.1 \
  --rpc-host 127.0.0.1

  Run Second Local Peer
node dist/index.js 3102 \
  --profile testnet \
  --host 127.0.0.1 \
  --rpc-host 127.0.0.1 \
  --peer ws://127.0.0.1:3101

  Check Status
Node A:
http://127.0.0.1:4101/status

Node B:
http://127.0.0.1:4102/status

Explorer
http://127.0.0.1:4101/index

Useful Endpoints
/status
/health
/peers
/sync
/storage
/diagnostics
/diagnostics/network
/metrics
/telemetry
/debug/replay-verify
/debug/block-validate?height=0
/debug/state-root-check?height=0
Expected Testnet Status
chainId: dubzchain-testnet
rewardNow: 3
syncProgressPct: 100
syncLagBlocks: 0

Notes
Do not use devnet files for public testnet.

Public testnet chain files should use ports:
3101
3102
3103

Devnet chain files usually use:
3001
3002
3003

Then run:

```bash
ls README.md