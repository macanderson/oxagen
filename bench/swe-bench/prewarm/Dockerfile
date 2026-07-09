# Overlay Dockerfile for pre-baked ("prewarmed") SWE-bench task images.
#
# Built by bench/swe-bench/prewarm.py on top of a task's own environment image
# (the "taskbase" — the task's environment/Dockerfile built as-is, so any RUN
# steps the task adds on top of the swebench instance image are preserved).
# The result bakes in everything the Oxagen adapter's install() step would
# otherwise do at trial time (~109s/task measured in the smoke run):
#
#   1. Node 22 (NodeSource, debian/ubuntu path)
#   2. the oxagen CLI bundle + tree-sitter *.wasm assets
#   3. the /usr/local/bin/oxagen wrapper (byte-identical to the one the
#      adapter writes at runtime — see oxagen_agent.py install() step 2)
#   4. static fast-search binaries rg/fd/fzf (optional — searchbin/ may be empty)
#   5. /usr/local/lib/oxagen/.bundle.sha256 — the bundle's sha256, which the
#      adapter reads at install time to skip the bundle/wasm re-upload
#
# Build context (staged by prewarm.py into a temp dir):
#   Dockerfile        this file
#   oxagen/           oxagen.mjs + *.wasm + .bundle.sha256
#   searchbin/        rg + fd + fzf (static x86_64 binaries) — any subset the
#                     host cache could provision (may be empty)
#
# The runtime adapter remains fully self-sufficient: if this image is absent
# or the bake fails, the trial falls back to the normal build + runtime
# install path (see PrewarmedDockerEnvironment in
# src/oxagen_swe_bench/prewarm_env.py).

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Bundle + wasm assets + sha256 marker. COPY of a directory includes dotfiles,
# so .bundle.sha256 lands alongside oxagen.mjs.
COPY oxagen/ /usr/local/lib/oxagen/

# Static fast-search tools rg/fd/fzf (no-op when searchbin/ is empty).
COPY searchbin/ /usr/local/bin/

# Node 22 + the oxagen wrapper. Mirrors the adapter's _NODE_INSTALL_SCRIPT
# fast-path semantics (keep existing Node >= 20) and its exact wrapper bytes.
# Fail loudly when the base image has no apt-get: prewarm.py records the
# failure and skips this image, and the trial's runtime Node install fallback
# (which also covers apk/dnf/yum) still works.
RUN set -eu; \
    need_node=1; \
    if command -v node >/dev/null 2>&1; then \
      major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; \
      if [ "${major:-0}" -ge 20 ]; then need_node=0; fi; \
    fi; \
    if [ "$need_node" -eq 1 ]; then \
      if ! command -v apt-get >/dev/null 2>&1; then \
        echo "oxagen-prewarm: base image has no apt-get; cannot bake Node here" \
             "(runtime install fallback still works)" >&2; \
        exit 1; \
      fi; \
      export DEBIAN_FRONTEND=noninteractive; \
      apt-get update -qq; \
      apt-get install -y -qq curl ca-certificates; \
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
      apt-get install -y -qq nodejs; \
    fi; \
    node --version; \
    printf '#!/bin/sh\nexec node /usr/local/lib/oxagen/oxagen.mjs "$@"\n' > /usr/local/bin/oxagen; \
    chmod +x /usr/local/bin/oxagen; \
    for b in rg fd fzf; do \
      if [ -f "/usr/local/bin/$b" ]; then chmod 755 "/usr/local/bin/$b"; fi; \
    done; \
    oxagen --version

# DuckDB for the persistent context engine (OXAGEN_INSTALL_DUCKDB=1 — the
# differentiated recipe's default). The adapter's runtime `npm install duckdb`
# was measured to blow Harbor's 360s agent-setup budget under Rosetta
# emulation (AgentSetupTimeoutError, job optimal-bo3-20260707); with the
# package pre-baked the runtime install resolves in seconds. Best-effort by
# design: the adapter already treats a missing duckdb as a soft failure and
# falls back to the in-memory context engine.
RUN set -u; \
    if npm install --prefix /usr/local/lib/oxagen duckdb; then \
      echo "oxagen-prewarm: duckdb baked"; \
    else \
      echo "oxagen-prewarm: duckdb bake failed; adapter installs at runtime (or degrades gracefully)" >&2; \
    fi
