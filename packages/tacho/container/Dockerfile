# The contained tier's image (ADR-152). Build it from the repository root:
#   docker build -f packages/tacho/container/Dockerfile --build-arg HARNESS=claude-code -t oxagen/contained-claude-code .
# `base` holds everything the launcher measures: the entry, the hook, and the
# managed-settings links that point at the read-only session mount. The final
# stage adds one harness. The Docker test builds `base` with a stub harness,
# so it exercises the same entry, hook and settings path this image ships.
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY packages/tacho/container/entry.mjs packages/tacho/container/hook.mjs /opt/oxagen/
RUN mkdir -p /etc/claude-code /etc/codex \
    && ln -s /opt/oxagen/session/settings.json /etc/claude-code/managed-settings.json \
    && ln -s /opt/oxagen/session/requirements.toml /etc/codex/requirements.toml \
    && chmod -R a-w /opt/oxagen
LABEL sh.oxagen.containment.profile="oxagen-linux-docker-v1"
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node", "/opt/oxagen/entry.mjs"]

FROM base
ARG HARNESS
ARG CODEX_VERSION=0.155.1
ARG CLAUDE_VERSION=2.1.280
RUN case "$HARNESS" in codex) npm install -g "@openai/codex@$CODEX_VERSION" ;; claude-code) npm install -g "@anthropic-ai/claude-code@$CLAUDE_VERSION" ;; *) exit 1 ;; esac \
    && npm cache clean --force
