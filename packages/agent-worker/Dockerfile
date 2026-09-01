# syntax=docker/dockerfile:1
# The durable agent worker — the long-lived process that claims runs from
# agent.agent_runs and drives turns (agent-engine v2 Phase A;
# docs/specs/agent-engine-v2/plan.md "Phase A — Give the durable worker a
# home"). Build from the REPO ROOT:
#
#   docker build -f packages/agent-worker/Dockerfile .
#
# Two stages, one for each engine the worker can run:
#
#   1. `stella-build` compiles `stella-serve` from macanderson/stella at the
#      exact version pinned in packages/stella-engine-client/sidecar.config.json
#      — the same pin, resolved the same way, as .github/workflows/
#      stella-sidecar.yml, so the binary in the image is the one the wire
#      contract was verified against. Built from source because stella builds
#      a serve container in CI but publishes no versioned artifact oxagen can
#      pin (macanderson/oxagen#2547 carries that upstream ask).
#   2. `runtime` is the Node monorepo, run from TypeScript source with tsx —
#      every workspace package sets `main: ./src/index.ts`, so there is no
#      build step to run and nothing to compile.
#
# The image runs fine with OXAGEN_ENGINE unset or `ts`; STELLA_SERVE_BIN is
# baked so `stella` needs only the flag.

ARG NODE_IMAGE=node:24-bookworm-slim

# ── Stage 1: the engine ─────────────────────────────────────────────────────
FROM rust:1-bookworm AS stella-build

# The pin lives in the repo, not in this file: copy the config in and read it,
# so bumping sidecar.config.json rebuilds the right version with no second
# place to update.
COPY packages/stella-engine-client/sidecar.config.json /tmp/sidecar.config.json
RUN apt-get update && apt-get install -y --no-install-recommends jq git \
    && rm -rf /var/lib/apt/lists/*
RUN STELLA_VERSION="$(jq -r '.stellaVersion' /tmp/sidecar.config.json)" \
    && git clone --depth 1 --branch "v${STELLA_VERSION}" \
        https://github.com/macanderson/stella.git /stella-src \
    && cd /stella-src \
    && cargo build --release -p stella-serve --bin stella-serve \
    && install -m 0755 target/release/stella-serve /usr/local/bin/stella-serve \
    && rm -rf /stella-src /usr/local/cargo/registry

# ── Stage 2: the worker ─────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production
# git: the repo-edit path clones and pushes; ca-certificates for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g corepack@latest && corepack enable

WORKDIR /repo
# The whole workspace, not a pruned subset: the worker runs from TS source and
# its dependency closure (@oxagen/agent → handlers → half the workspace) makes
# a hand-pruned copy a maintenance trap that breaks on every new package edge.
# .dockerignore keeps node_modules, .git and app build output out of the
# context, which is where the actual bulk lives.
COPY . .
# `--prod=false`: tsx and typescript are devDependencies, and running from
# source needs them at runtime by design.
RUN corepack prepare --activate \
    && pnpm install --frozen-lockfile --prod=false \
    && pnpm store prune

COPY --from=stella-build /usr/local/bin/stella-serve /usr/local/bin/stella-serve
ENV STELLA_SERVE_BIN=/usr/local/bin/stella-serve

# SIGTERM → worker.stop() → drain in-flight runs → shut sidecars down. tsx
# execs node, and pnpm would swallow the signal, so run tsx directly.
WORKDIR /repo/packages/agent-worker
CMD ["npx", "tsx", "src/main.ts"]
