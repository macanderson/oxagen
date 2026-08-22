#!/usr/bin/env bash
#
# Build one app and lay it out as an artifact the shared AWS instance can run.
#
#   tools/scripts/package-for-node.sh <docs|app|api|mcp>
#
# Writes `dist-deploy/<service>/`, whose root carries an `oxagen-run.json`
# telling the node's `deploy-service.sh` which image to start, on which port,
# with which command, and where to read its configuration. That contract is
# documented in the oxagen-aws-infra repository, `tools/node/README.md`.
#
# This is a script rather than four blocks of YAML because the four services
# are packaged in genuinely different ways and the differences are the
# interesting part — they should be readable in one file, next to each other,
# instead of spread across a workflow where only a diff shows them.
#
# The node is arm64 (a t4g.medium). Run this on an arm runner: a native module
# built for x86 installs and tests green here and fails to load at first
# request there.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <docs|app|api|mcp>" >&2
  exit 2
fi

readonly SERVICE=$1

# Assigned before `readonly` so a failed `cd` is a failed script rather than a
# successful declaration holding an empty path — which would make $OUT below
# `/dist-deploy/<service>` and point the `rm -rf` at the filesystem root.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
readonly ROOT
readonly OUT=$ROOT/dist-deploy/$SERVICE

cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Ports. These must match `tools/caddy/Caddyfile` in oxagen-aws-infra, which is
# what proxies to them; nothing enforces the agreement and a mismatch shows up
# as a 502. They are the same values as `PORTS` in @oxagen/config, so a service
# started by hand from a checkout lands where a developer expects.
port_for() {
  case $1 in
    app)  echo 3000 ;;
    docs) echo 3002 ;;
    api)  echo 4000 ;;
    mcp)  echo 4100 ;;
    *)    fail "unknown service '$1'" ;;
  esac
}

# Write the manifest. `config_prefix` is omitted for `docs`, which renders MDX
# and holds no credentials — a service that reads no secrets should not be
# handed 26 of them.
write_manifest() {
  local port=$1 memory=$2 health=$3 config=$4
  shift 4
  local command_json
  command_json=$(printf '%s\n' "$@" | jq -R . | jq -sc .)

  jq -n \
    --argjson port "$port" \
    --arg image "node:22-alpine" \
    --argjson command "$command_json" \
    --arg memory "$memory" \
    --arg health "$health" \
    --arg config "$config" \
    '{
       port: $port,
       image: $image,
       command: $command,
       memory: $memory,
       health_path: $health,
       env: { NEXT_TELEMETRY_DISABLED: "1" }
     }
     + (if $config == "" then {} else { config_prefix: $config } end)' \
    > "$OUT/oxagen-run.json"

  log "manifest: $(jq -c . "$OUT/oxagen-run.json")"
}

# Next's standalone output deliberately excludes the static assets and
# everything under public/, expecting whatever serves it to supply them.
# Without this the site renders with no CSS and every image broken — which
# reads as a styling regression rather than a packaging one.
#
# Where server.js lands depends on the workspace: in a monorepo Next preserves
# the path from the workspace root, so it is apps/<name>/server.js with a
# single shared node_modules beside it. Both must ship whole.
assemble_next() {
  local app_dir=$1
  local standalone=$app_dir/.next/standalone
  local server_rel
  server_rel=$(cd "$standalone" 2>/dev/null && find . -maxdepth 5 -name server.js \
    -not -path '*/node_modules/*' | head -1 | sed 's|^\./||') \
    || fail "no standalone output under $standalone"
  [[ -n ${server_rel:-} ]] || fail "no standalone server.js under $standalone — did the build run with STANDALONE=1?"

  local app_rel
  app_rel=$(dirname "$server_rel")
  log "standalone entrypoint: $server_rel"

  cp -R "$standalone/." "$OUT/"
  mkdir -p "$OUT/$app_rel/.next"
  if [[ -d $app_dir/.next/static ]]; then cp -R "$app_dir/.next/static" "$OUT/$app_rel/.next/static"; fi
  if [[ -d $app_dir/public ]]; then cp -R "$app_dir/public" "$OUT/$app_rel/public"; fi

  SERVER_REL=$server_rel
}

case $SERVICE in
  docs)
    log "building @oxagen/docs"
    STANDALONE=1 pnpm --filter @oxagen/docs build
    assemble_next apps/docs
    write_manifest "$(port_for docs)" 512m "/" "" node "$SERVER_REL"
    ;;

  app)
    log "building @oxagen/app"
    # The same 5GB heap the CI build uses. Next's own TypeScript pass is off
    # (`ignoreBuildErrors`), so this is the compile alone.
    NODE_OPTIONS=--max-old-space-size=5120 STANDALONE=1 pnpm --filter @oxagen/app build
    assemble_next apps/app

    # `serverExternalPackages` and the turbopack aliases keep several packages
    # OUT of the standalone trace on purpose — native addons Turbopack cannot
    # parse, and heavy libraries loaded lazily. On Vercel they resolved from a
    # root `pnpm install` the platform ran beside the function. Nothing does
    # that here, so the runtime dependencies are installed into the artifact.
    #
    # `pnpm deploy` is what produces a real, non-symlinked node_modules for one
    # workspace package; a plain copy of the monorepo's would be a tree of
    # symlinks into a store that does not ship.
    log "installing runtime dependencies for the externalised packages"
    pnpm deploy --filter @oxagen/app --prod --legacy "$ROOT/.deploy-app"
    # Merged rather than replaced: the standalone trace's node_modules holds
    # what Next bundled for it, and dropping that in favour of the install
    # would lose exactly the modules the trace was for.
    cp -R "$ROOT/.deploy-app/node_modules/." "$OUT/node_modules/"
    rm -rf "$ROOT/.deploy-app"

    write_manifest "$(port_for app)" 768m "/" "/oxagen/production" node "$SERVER_REL"
    ;;

  api)
    log "building @oxagen/api for node"
    pnpm --filter @oxagen/api build:node
    cp -R apps/api/dist/. "$OUT/"

    # No node_modules. build-node.mjs bundles the workspace packages and every
    # JS dependency into one file; its externals are all optional native
    # bindings behind a lazy require and a fallback.
    #
    # /health is Hono's own route. Checking it rather than "/" means the health
    # check proves the router is up, not merely that something answered.
    write_manifest "$(port_for api)" 512m "/health" "/oxagen/production" node server.cjs
    ;;

  mcp)
    log "building @oxagen/mcp"
    pnpm --filter @oxagen/mcp build
    [[ -f apps/mcp/dist/http.js ]] || fail "xmcp build produced no dist/http.js"
    cp -R apps/mcp/dist "$OUT/dist"

    # xmcp's bundler externalises the same heavy and native packages the app
    # does, for the same reason and with the same consequence: they have to be
    # on disk beside the bundle or the first tool call fails to resolve one.
    log "installing runtime dependencies for the externalised packages"
    pnpm deploy --filter @oxagen/mcp --prod --legacy "$ROOT/.deploy-mcp"
    cp -R "$ROOT/.deploy-mcp/node_modules" "$OUT/node_modules"
    rm -rf "$ROOT/.deploy-mcp"

    # MCP_PORT, not PORT: xmcp.config.ts reads that name specifically. The
    # manifest's `port` is what Caddy proxies to and what the health check
    # polls, so the two have to be the same number and the env var below is
    # how the application is told.
    write_manifest "$(port_for mcp)" 512m "/health" "/oxagen/production" node dist/http.js
    tmp=$(mktemp)
    jq --arg p "$(port_for mcp)" '.env.MCP_PORT = $p' "$OUT/oxagen-run.json" > "$tmp"
    mv "$tmp" "$OUT/oxagen-run.json"
    ;;

  *)
    fail "unknown service '$SERVICE' — expected docs, app, api or mcp"
    ;;
esac

log "$SERVICE packaged into dist-deploy/$SERVICE ($(du -sh "$OUT" | cut -f1))"
