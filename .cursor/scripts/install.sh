#!/usr/bin/env bash
# Oxagen Cloud Agent — self-bootstrapping repository install (idempotent).
# Provisions the full toolchain (Node 24, pnpm, Docker + fuse-overlayfs, Atlas),
# installs workspace dependencies, and writes local dev env files. Safe to run
# on a bare default image or on a warm snapshot (each step is guarded).
set -euo pipefail

NODE_VERSION="24.21.0"
PNPM_VERSION="11.7.0"

echo "[install] === Oxagen environment bootstrap ==="

# ---------------------------------------------------------------------------
# 1. Node 24 via nvm, made to win over any earlier `node` on PATH (Cursor
#    injects /exec-daemon which ships an older node), persisted for login shells.
# ---------------------------------------------------------------------------
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "[install] installing nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
if ! nvm ls "$NODE_VERSION" >/dev/null 2>&1; then
  echo "[install] installing node $NODE_VERSION"
  nvm install "$NODE_VERSION"
fi
nvm alias default "$NODE_VERSION" >/dev/null
NODE_BIN="$NVM_DIR/versions/node/v${NODE_VERSION}/bin"
export PATH="$NODE_BIN:$PATH"
if ! grep -q "versions/node/v${NODE_VERSION}/bin" "$HOME/.bashrc" 2>/dev/null; then
  echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$HOME/.bashrc"
fi
echo "[install] node $(node -v)"

# pnpm via corepack, pinned.
corepack enable >/dev/null 2>&1 || true
corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 || true
echo "[install] pnpm $(pnpm -v)"

# ---------------------------------------------------------------------------
# 2. Atlas CLI (Postgres migrations).
# ---------------------------------------------------------------------------
if ! command -v atlas >/dev/null 2>&1; then
  echo "[install] installing atlas"
  curl -fsSL https://release.ariga.io/atlas/atlas-linux-amd64-latest -o /tmp/atlas
  chmod +x /tmp/atlas && sudo mv /tmp/atlas /usr/local/bin/atlas
fi
echo "[install] atlas $(atlas version 2>&1 | head -1)"

# ---------------------------------------------------------------------------
# 3. Docker engine + fuse-overlayfs (nested-container storage driver) + iptables.
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "[install] installing docker engine"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sudo sh /tmp/get-docker.sh
fi
if ! command -v fuse-overlayfs >/dev/null 2>&1; then
  echo "[install] installing fuse-overlayfs + iptables"
  sudo apt-get update -qq || true
  sudo apt-get install -y -qq fuse-overlayfs iptables uidmap || true
fi
sudo mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "storage-driver": "fuse-overlayfs", "iptables": true }' | sudo tee /etc/docker/daemon.json >/dev/null
fi
sudo usermod -aG docker "$USER" 2>/dev/null || true
echo "[install] docker $(docker --version)"

# Pre-pull the datastore images so the snapshot carries them (best-effort; the
# start script pulls anything missing on first boot regardless).
if ! docker info >/dev/null 2>&1; then
  sudo bash -c 'nohup dockerd >/tmp/dockerd.log 2>&1 &' || true
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
if docker info >/dev/null 2>&1; then
  for img in postgres:16-alpine neo4j:5.24-community clickhouse/clickhouse-server:24.8-alpine; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img" || true
  done
fi

# ---------------------------------------------------------------------------
# 4. Workspace dependencies.
# ---------------------------------------------------------------------------
cd "${OXAGEN_REPO_DIR:-$PWD}"
# pnpm must not auto-run `install` (and its lefthook `prepare`) before every
# script invocation; deps are managed explicitly here.
pnpm config set verify-deps-before-run false >/dev/null 2>&1 || true
# The root `prepare` runs `lefthook install`, which refuses whenever git's
# core.hooksPath is set (Cursor sets one in interactive agent VMs). Git hooks
# are irrelevant here (CI runs the gate); clear it so `prepare` succeeds.
if git rev-parse --git-dir >/dev/null 2>&1; then
  git config --local --unset-all core.hooksPath 2>/dev/null || true
fi
pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 5. Local dev env files (Vercel is the source of truth in prod; here we
#    generate self-contained local values). Created only if absent.
# ---------------------------------------------------------------------------
if [ ! -f .env.local ]; then
  SECRET="$(openssl rand -hex 32)"
  cat > .env.local <<EOF
NODE_ENV=development
OXAGEN_LOCAL_DEV=1
INNGEST_DEV=1
DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=oxagen
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=oxagen-dev
NEO4J_DATABASE=neo4j
BETTER_AUTH_SECRET=${SECRET}
BETTER_AUTH_URL=http://localhost:3000
APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
MCP_URL=http://localhost:4100
STELLA_SERVE_URL=http://127.0.0.1:4300
STELLA_SERVE_TOKEN=dev-token-change-me
STRIPE_SECRET_KEY=sk_test_dummydevkeyoxagenlocal000000000000
STRIPE_WEBHOOK_SECRET=whsec_dummydevsecretoxagenlocal0000000000
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_dummydevkeyoxagenlocal000000000000
STRIPE_PUBLISHABLE_KEY=pk_test_dummydevkeyoxagenlocal000000000000
EOF
  for d in apps/app apps/api apps/mcp; do cp .env.local "$d/.env.local"; done
  echo "[install] wrote .env.local (root, apps/app, apps/api, apps/mcp)"
else
  echo "[install] .env.local present — leaving in place"
fi

echo "[install] done"
