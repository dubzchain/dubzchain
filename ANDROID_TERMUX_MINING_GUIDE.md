# DubzChain Android / Termux Mining Guide

## Overview

DubzChain can run on Android through Termux.

This allows users to:

- run a DubzChain testnet node
- mine from an Android phone
- connect to a Mac, laptop, VPS, or seed node
- check node status from Termux
- help keep the network moving

Phone mining is best for:

- testnet participation
- community onboarding
- lightweight mining
- “mine on the go” use cases

Phones are not ideal for heavy 24/7 mining because of heat, battery drain, and Android background limits.

---

# 1. Install Termux

https://github.com/termux/termux-app/releases

---

# 2. Update Termux

pkg update && pkg upgrade -y

# 3. Install Requirements\

pkg install nodejs-lts git nano unzip wget curl -y

Check Node.js:

node -v
npm -v

# 4. download dubzchain zip

dubzchain.zip 

# 5. unzip the file

termux command
unzip dubzchain.zip

# 6. run the node
