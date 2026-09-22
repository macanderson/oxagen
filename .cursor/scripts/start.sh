#!/usr/bin/env bash
# Oxagen Cloud Agent — per-boot service reconciliation (idempotent).
# Brings up the Docker datastores, applies migrations, and starts the Inngest
# dev server. The web/service dev servers run as terminals, not here.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
export INNGEST_DEV=1
unset DATABASE_URL || true

COMPOSE_FILE="docker-compose.dev.yml"

# 1. Docker daemon (nested container: fuse-overlayfs storage driver).
if ! docker info >/dev/null 2>&1; then
  echo "[start] starting dockerd"
  sudo mkdir -p /etc/docker
  if [ ! -f /etc/docker/daemon.json ]; then
    echo '{ "storage-driver": "fuse-overlayfs", "iptables": true }' | sudo tee /etc/docker/daemon.json >/dev/null
  fi
  sudo bash -c 'nohup dockerd >/tmp/dockerd.log 2>&1 &'
  for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
docker info >/dev/null 2>&1 || { echo "[start] dockerd failed to come up"; tail -20 /tmp/dockerd.log 2>/dev/null; exit 1; }
echo "[start] docker ready ($(docker --version))"

# 2. Datastores up + healthy.
docker compose -f "$COMPOSE_FILE" up -d postgres neo4j clickhouse
echo "[start] waiting for datastores to report healthy"
deadline=$((SECONDS + 180))
while [ $SECONDS -lt $deadline ]; do
  healthy=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Health}}' 2>/dev/null | grep -c healthy || true)
  [ "${healthy:-0}" -ge 3 ] && { echo "[start] datastores healthy"; break; }
  sleep 3
done

# 3. Migrations + platform seed (idempotent).
echo "[start] applying migrations"
pnpm db:migrate

# 4. Inngest dev server (durable/async capability runner), detached, guarded.
PIDF=".inngest-dev.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
  echo "[start] inngest dev server already running"
else
  BIN="node_modules/inngest-cli/bin/inngest"
  [ -x "$BIN" ] || BIN="inngest-cli"
  nohup "$BIN" dev -u http://127.0.0.1:4000/api/inngest >/tmp/inngest.log 2>&1 &
  echo $! > "$PIDF"
  echo "[start] inngest dev server started (pid $(cat "$PIDF"))"
fi

echo "[start] done"
