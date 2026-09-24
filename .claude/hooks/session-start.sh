#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# Brings a fresh cloud container up to what CI's oxagen-ci-* images carry, so
# an agent can install, lint, typecheck, run a single test file, run the three
# Playwright specs, and migrate the local stores. It does nothing on a laptop:
# the guard below returns unless CLAUDE_CODE_REMOTE is "true".
#
# Every step is idempotent. The container is snapshotted after this hook
# finishes, so installs made here are cached for later sessions.
#
# What the base image gets wrong for this repo, and the fix for each:
#   Node 22 on PATH, repo pins 24     nvm install from .nvmrc, PATH via CLAUDE_ENV_FILE
#   Chromium for Playwright 1.56      install apps/app's version into ~/.cache/ms-playwright
#   no atlas, no fd                   atlasgo.sh at pipeline.yml's ATLAS_VERSION, apt fd-find
#   no Tauri system libraries         apt webkit2gtk and friends for apps/desktop/src-tauri
#   Docker daemon not running         start dockerd, then postgres, clickhouse and neo4j
#   ClickHouse's 262144 nofile limit  the sandbox caps nofile at 20000, so override it
#   no .env.local                     write one from CI's placeholder values
#
# The stores are best-effort: a failure there prints a warning and the session
# still starts, because most unit tests do not need a database.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
env_file="${CLAUDE_ENV_FILE:-/dev/null}"
log() { echo "[session-start] $*" >&2; }

# Node at the version the repo pins, with pnpm from package.json via corepack.
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
node_version="$(cat .nvmrc)"
nvm install "$node_version" >/dev/null
nvm alias default "$node_version" >/dev/null
node_bin="$(dirname "$(nvm which "$node_version")")"
export PATH="$node_bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
log "node $(node -v), pnpm $(pnpm -v)"

playwright_path="$HOME/.cache/ms-playwright"
{
  echo "export PATH=\"$node_bin:\$PATH\""
  echo "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
  echo "export PLAYWRIGHT_BROWSERS_PATH=\"$playwright_path\""
} >>"$env_file"

# System packages: fd for search, and what tauri-build links against.
apt_packages=(fd-find libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev)
if ! dpkg -s "${apt_packages[@]}" >/dev/null 2>&1; then
  log "installing system packages"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${apt_packages[@]}" >/dev/null
fi
command -v fd >/dev/null || ln -sf "$(command -v fdfind)" /usr/local/bin/fd

# Atlas at the version CI bakes into its image.
atlas_version="$(sed -n 's/^  ATLAS_VERSION: "\(.*\)"$/\1/p' .github/workflows/pipeline.yml)"
atlas_version="${atlas_version:-v1.2.2}"
if ! atlas version 2>/dev/null | grep -q "${atlas_version}"; then
  log "installing atlas ${atlas_version}"
  curl -sSf https://atlasgo.sh | ATLAS_VERSION="$atlas_version" sh -s -- -y >/dev/null
fi

# Workspace dependencies. Not --frozen-lockfile: a branch that changed a
# package.json should still start, and CI enforces the lockfile.
pnpm install --prefer-offline

# Chromium matching apps/app's @playwright/test, not the image's copy.
PLAYWRIGHT_BROWSERS_PATH="$playwright_path" pnpm --filter @oxagen/app exec playwright install chromium >/dev/null

# Local env file with CI's placeholder values (pipeline.yml `env:`), pointed at
# the docker-compose.dev.yml ports. Never overwrites one that exists.
if [ ! -f .env.local ]; then
  log "writing .env.local"
  cat >.env.local <<EOF
DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen?sslmode=disable
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=oxagen
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=oxagen-dev
BETTER_AUTH_SECRET=ci-secret-ci-secret-ci-secret-ci-x
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
STRIPE_SECRET_KEY=sk_test_ci
STRIPE_PUBLISHABLE_KEY=pk_test_ci
STRIPE_WEBHOOK_SECRET=whsec_test_ci
INNGEST_EVENT_KEY=ci_inngest_event
INNGEST_SIGNING_KEY=signkey-test-ci0000000000000000000000000000000000000000000000000000000000
AUTH_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
INGESTION_CRYPTO_PROVIDER=env
INGESTION_ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF
fi

start_stores() {
  if ! docker info >/dev/null 2>&1; then
    log "starting dockerd"
    # setsid: outlive the hook's process group, which the harness may reap.
    setsid nohup dockerd >/tmp/dockerd.log 2>&1 </dev/null &
    for _ in $(seq 1 30); do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
    docker info >/dev/null 2>&1 || return 1
  fi
  local override
  override="$(mktemp --suffix=.yml)"
  cat >"$override" <<'EOF'
services:
  clickhouse:
    ulimits:
      nofile:
        soft: 20000
        hard: 20000
EOF
  # errexit is off inside a function called from `if`, hence the returns.
  docker compose -f docker-compose.dev.yml -f "$override" up -d --wait postgres clickhouse neo4j >/tmp/compose.log 2>&1 || return 1
  rm -f "$override"
  # A shell-exported DATABASE_URL would override .env.local (CLAUDE.md).
  env -u DATABASE_URL pnpm db:migrate >/tmp/db-migrate.log 2>&1 || return 1
}

if start_stores; then
  log "postgres :5433, clickhouse :8123, neo4j :7687 migrated and seeded"
else
  log "WARNING: local stores are not ready; see /tmp/dockerd.log, /tmp/compose.log and /tmp/db-migrate.log"
fi
