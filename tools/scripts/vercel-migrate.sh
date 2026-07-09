#!/usr/bin/env bash
# vercel-migrate.sh — apply Postgres migrations during the Vercel PRODUCTION build.
#
# Why this exists: the CI pipeline's migrate job (pipeline.yml) is supposed to
# apply committed Atlas migrations to prod on every push to main, but GitHub
# Actions can be blocked entirely (org billing), so code deploys via Vercel
# while the DB silently drifts behind ("column ... does not exist" 500s in
# prod). Running the apply inside the Vercel build closes that gap at the only
# choke point every production deploy MUST pass through — and it runs BEFORE
# the new code goes live, so the DB is never behind the code it serves.
#
# Safety properties:
#   - Production builds only (VERCEL_ENV=production). Preview builds never
#     touch prod; the preview DB keeps its existing pipeline path.
#   - No-op when there is nothing pending — costs one status query.
#   - Checksums validated (atlas migrate validate) before any apply.
#   - Atlas serializes concurrent appliers via its revision-table lock, and
#     applies each migration file in its own transaction — a killed build
#     leaves the DB at a clean file boundary and the next build resumes.
#   - Fails the build (exit 1) if an apply errors: better a failed deploy than
#     new code running against a half-migrated schema.
#   - Refuses to apply when the revision table is EMPTY but migration files
#     exist (would re-create every object on a live DB) — that state needs a
#     human (atlas migrate baseline / the manual db-migrate.yml workflow).
set -euo pipefail

if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "[vercel-migrate] VERCEL_ENV='${VERCEL_ENV:-unset}' — not a production build, skipping migrations."
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[vercel-migrate] WARNING: DATABASE_URL is not set in the build environment — cannot migrate. Deploying anyway (code may be ahead of schema)." >&2
  exit 0
fi

# Keep in sync with ATLAS_VERSION in .github/workflows/pipeline.yml.
ATLAS_VERSION="${ATLAS_VERSION:-v0.38.0}"
ATLAS_DIR="${HOME}/.atlas-bin"
ATLAS="${ATLAS_DIR}/atlas"

if [ ! -x "$ATLAS" ]; then
  echo "[vercel-migrate] installing Atlas ${ATLAS_VERSION}…"
  mkdir -p "$ATLAS_DIR"
  curl -sSf https://atlasgo.sh | ATLAS_VERSION="$ATLAS_VERSION" ATLAS_INSTALL_DIR="$ATLAS_DIR" ATLAS_NO_MODIFY_PATH=1 sh
fi
"$ATLAS" version

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT/packages/database"

echo "[vercel-migrate] validating migration directory checksums…"
"$ATLAS" migrate validate --dir "file://atlas/migrations"

echo "[vercel-migrate] migration status (before):"
STATUS_JSON="$("$ATLAS" migrate status --env ci --format '{{ json . }}')"
echo "$STATUS_JSON"

CURRENT="$(printf '%s' "$STATUS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(s.Current ?? "")})')"
PENDING_COUNT="$(printf '%s' "$STATUS_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log((s.Pending ?? []).length)})')"

if [ "$PENDING_COUNT" = "0" ]; then
  echo "[vercel-migrate] no pending migrations — nothing to do."
  exit 0
fi

# An empty/absent revision baseline with pending files means Atlas would try to
# re-create the entire schema on a live database. Never do that automatically.
if [ -z "$CURRENT" ] || [ "$CURRENT" = "No migration applied yet" ]; then
  echo "[vercel-migrate] ERROR: revision table is empty but ${PENDING_COUNT} migration file(s) exist. Refusing to auto-apply the full history to a live DB — baseline it manually (db-migrate.yml workflow)." >&2
  exit 1
fi

echo "[vercel-migrate] applying ${PENDING_COUNT} pending migration(s)…"
"$ATLAS" migrate apply --env ci --lock-timeout 120s

echo "[vercel-migrate] migration status (after):"
"$ATLAS" migrate status --env ci
echo "[vercel-migrate] done."
