# DubzChain Explorer Deployment Guide

## Overview

This guide explains how to deploy a public DubzChain explorer node for the public testnet.

The explorer provides:
- chain status
- peer information
- sync diagnostics
- storage diagnostics
- telemetry
- metrics
- replay verification
- block validation

---

# 1. Public Testnet Identity

```text
chainId: dubzchain-testnet
reward: 3 DUBZ
maxSupply: 33,000,000
targetBlockTime: 21 seconds

Genesis:
7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff

2. Recommended Hardware

Minimum:

2 CPU
4GB RAM
50GB SSD

Recommended:

4 CPU
8GB RAM
100GB SSD

3. Recommended Hosting Providers

Examples:

DigitalOcean
Vultr
Hetzner
AWS
Linode

4. Install DubzChain
git clone YOUR_REPO_URL
cd dubzchain
npm install
npx tsc

5. Configure Environment
cp env.example .env

Set:

DUBZ_NETWORK_PROFILE=testnet

6. Run Explorer Node

Example:

node dist/index.js 3101 \
  --profile testnet \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0

Explorer:

http://SERVER_IP:4101/index

7. Recommended Reverse Proxy

Recommended:

nginx

8. Example nginx Reverse Proxy

Example:

server {
    server_name explorer.dubzchain.net;

    location / {
        proxy_pass http://127.0.0.1:4101;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

9. TLS / HTTPS

Recommended:

Let's Encrypt

Example:

sudo certbot --nginx -d explorer.dubzchain.net

10. Recommended Public URLs

Examples:

https://explorer.dubzchain.net
https://rpc.dubzchain.net
https://telemetry.dubzchain.net

11. Useful Public Endpoints
/status
/health
/peers
/sync
/storage
/metrics
/telemetry
/index

12. Debug Endpoints
/debug/replay-verify
/debug/block-validate?height=0
/debug/state-root-check?height=0
/debug/send-history

Recommended:

disable some debug endpoints publicly later if needed.

13. Explorer Health Expectations

Healthy explorer:

syncProgressPct: 100
syncLagBlocks: 0
peersOpen > 0

14. Public Explorer Security

Recommended:

TLS enabled
firewall enabled
reverse proxy enabled
rate limiting
RPC auth
fail2ban

15. Monitoring

Recommended:

uptime monitoring
memory monitoring
peer monitoring
sync monitoring
disk monitoring

Useful endpoints:

/metrics
/telemetry
/status

16. Process Managers

Recommended:

pm2
systemd
tmux
screen

Example:

pm2 start dist/index.js --name dubz-explorer

17. Public Testnet Explorer Checklist

Before public release:

verify genesis hash
verify state root
verify replay validation
verify sync stability
verify peer discovery
verify metrics
verify TLS

18. Official Public Testnet Genesis
chainId:
dubzchain-testnet
genesisHash:
7ac9609058eadc8e8f3fc9b048b32135496131bd9cda53815c3b2c7bbf79e9ff
genesisStateRoot:
779a8e3120016ea09c16e38e20404d493efef8c0001b57970959be136d39fdd6

Then run:

```bash
ls EXPLORER_DEPLOYMENT_GUIDE.md