# syntax=docker/dockerfile:1
# CI toolchain image for the Oxagen monorepo.
#
# Two published targets (see .github/workflows/ci-image.yml):
#   ghcr.io/macanderson/oxagen-ci-base — Node 24 + pnpm (corepack) + Atlas +
#     postgresql-client. Used by every non-e2e CI job.
#   ghcr.io/macanderson/oxagen-ci-e2e  — base + Playwright Chromium and its OS
#     deps, pinned to apps/app's @playwright/test version. Used by e2e jobs.
#
# Version pins arrive as build args from ci-image.yml, which reads them from
# the repo (packageManager in package.json, @playwright/test in
# apps/app/package.json) so the image cannot drift from the toolchain that
# produced the lockfile. ATLAS_VERSION must match the env pin in
# .github/workflows/pipeline.yml and nightly.yml.

FROM node:24-bookworm AS base

ARG PNPM_VERSION=11.7.0
ARG ATLAS_VERSION=v0.38.0

# GitHub Actions container jobs run with HOME=/github/home, not /root, so
# every cache the image pre-warms must live at a HOME-independent path or it
# is invisible at job time.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ripgrep/fd/fzf: fast search toolchain for any agent or script shelling out
# in CI. Debian ships fd-find's binary as `fdfind`, hence the symlink.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client jq ripgrep fd-find fzf \
    && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Corepack (not a global pnpm binary) so the repo's package.json
# `packageManager` field stays authoritative: if it bumps before the next
# image rebuild, corepack transparently fetches the new pnpm at job time
# instead of running a stale binary.
RUN npm install -g corepack@latest \
    && corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && pnpm --version

RUN curl -sSf https://atlasgo.sh | ATLAS_VERSION="${ATLAS_VERSION}" sh \
    && atlas version

FROM base AS e2e

ARG PLAYWRIGHT_VERSION=1.60.0

# HOME-independent browser path (same reason as COREPACK_HOME above); the
# workflow's `playwright install chromium` step becomes a no-op when the baked
# build matches, and a plain download (deps already present) when it doesn't.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
    && rm -rf /root/.npm /var/lib/apt/lists/*
