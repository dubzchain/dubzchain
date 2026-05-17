# DubzChain Seed Node Guide

## Overview

Seed nodes help new DubzChain peers discover the public network.

Seed nodes should:
- remain online 24/7
- advertise stable public URLs
- support websocket peer discovery
- maintain high uptime

---

# 1. Public Testnet Identity

```text
chainId: dubzchain-testnet
reward: 3 DUBZ
maxSupply: 33,000,000
targetBlockTime: 21 seconds

Genesis:
7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff

2. Recommended VPS Specs

Minimum:

2 CPU
4GB RAM
50GB SSD

Recommended:

4 CPU
8GB RAM
100GB SSD

3. Recommended Providers

Examples:

DigitalOcean
Vultr
Linode
AWS
Hetzner

4. Open Firewall Ports

Recommended:

3101 TCP
4101 TCP

5. Install Node.js

Recommended:

Node.js 20+

Verify:

node -v
npm -v

6. Install DubzChain
git clone YOUR_REPO_URL
cd dubzchain
npm install
npx tsc

7. Configure Environment

Example:

cp env.example .env

Set:

DUBZ_NETWORK_PROFILE=testnet

8. Generate TLS Certificates

Recommended:

Let's Encrypt

Example paths:

/etc/letsencrypt/live/seed1.dubzchain.net/fullchain.pem
/etc/letsencrypt/live/seed1.dubzchain.net/privkey.pem

9. Start Public Seed Node

Example:

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --advertise wss://seed1.dubzchain.net:3101

10. Recommended Public Seeds

Examples:

wss://seed1.dubzchain.net:3101
wss://seed2.dubzchain.net:3101
wss://seed3.dubzchain.net:3101

11. Verify Seed Connectivity

Check:

/peers
/status
/sync

Expected:

syncLagBlocks: 0
syncProgressPct: 100

12. Recommended Architecture

Recommended topology:

3+ public seed nodes
multiple geographic regions
separate VPS providers

Example:

US East
US West
Europe

13. Mining Recommendation

Seed nodes are preferably:

non-mining
stable
low restart frequency

Dedicated miners should run separately.

14. Public Seed Stability Rules

Recommended:

static IP
stable DNS
automatic restart
uptime monitoring
TLS renewal automation

15. Process Managers

Recommended:

pm2
systemd
screen
tmux

Example:

pm2 start dist/index.js --name dubz-seed

16. Monitoring

Recommended monitoring:

uptime
peer count
memory usage
sync lag
bandwidth
disk usage

Endpoints:

/metrics
/telemetry
/status

17. Backup Recommendations

Backup:

checkpoints
config
TLS certs
seed lists

Avoid sharing:

private checkpoint signing keys

18. Security Recommendations

Recommended:

firewall enabled
TLS enabled
RPC auth enabled
automatic updates
fail2ban
non-root user

19. Public Launch Checklist

Before launch:

verify genesis hash
verify state root
verify seed connectivity
verify sync
verify replay validation
complete attack tests
complete soak tests

20. Official Public Testnet Genesis
chainId:
dubzchain-testnet
genesisHash:
7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff
genesisStateRoot:
779a8e3120016ea09c16e38e20404d493efef8c0001b57970959be136d39fdd6

Then run:

```bash
ls SEED_NODE_GUIDE.md