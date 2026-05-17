Run:
node dist/index.js 3001 \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --advertise ws://YOUR_LAN_IP:3001 \
  --automine \
  --mine-empty \
  --mine-interval 21000 \
  --mine-yield 20000

Example:
node dist/index.js 3001 \
  --host 0.0.0.0 \
  --rpc-host 0.0.0.0 \
  --advertise ws://192.168.1.100:3001 \
  --automine \
  --mine-empty \
  --mine-interval 21000 \
  --mine-yield 20000