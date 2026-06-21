#!/usr/bin/env bash
#
# Claude Code on the web — environment Setup Script for oxagen-monorepo.
#
# Paste exactly this one line into claude.ai/code → Environments → <env> → Setup script:
#
#     bash tools/scripts/cloud-setup.sh
#
# It runs ONCE before Claude Code launches and the resulting filesystem is cached
# for every later session in this environment, so keep it deterministic and < ~5 min.
# Per-session work (starting datastores, migrations, dev servers) is NOT done here —
# the agent does that with `pnpm dev` once the session is live.
#
set -euo pipefail

echo "▶ Node $(node -v) — pinning pnpm 11.7.0 via corepack"
corepack enable
corepack prepare pnpm@11.7.0 --activate

echo "▶ Installing workspace dependencies (cached into the environment image)"
pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

echo "▶ Pre-pulling datastore images (Postgres 16 / Neo4j 5.24 / ClickHouse 24.8)"
echo "  so the per-session 'pnpm dev' boot is fast instead of pulling ~600MB live."
docker compose -f docker-compose.dev.yml pull \
  || echo "⚠ image pre-pull skipped (docker not available at setup time — pulls happen on first 'pnpm dev')"

echo "✓ Cloud setup complete."
echo "  Next, in a session: run 'pnpm dev' to start Docker datastores + all apps,"
echo "  then 'pnpm gate' before committing. Datastores: PG :5433, Neo4j :7687, ClickHouse :8123."
