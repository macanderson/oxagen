# The Oxagen relay's image. Build it from the repository root:
#   docker build -f apps/relay/Dockerfile -t <your-registry>/oxagen-relay:<tag> .
#
# The build stage installs the relay and the workspace packages it imports,
# then bundles them into one file, dist/relay.cjs. build.mjs boots that file
# once with an empty environment and fails the build unless it stops at the
# configuration check. The runtime stage holds Node and the one file: no
# package manager, no node_modules, and no source.
#
# The relay listens on no port, so the image exposes none.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
# Corepack installs the pnpm version package.json names.
RUN corepack enable
COPY . .
# --ignore-scripts skips the root prepare script, which installs git hooks
# the image has no use for. esbuild runs without its install script.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@oxagen/relay..."
RUN pnpm --filter @oxagen/relay build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
COPY --from=build /src/apps/relay/dist/relay.cjs /opt/oxagen-relay/relay.cjs
# The base image's node user. A numeric id lets Kubernetes check runAsNonRoot.
USER 1000:1000
ENTRYPOINT ["node", "/opt/oxagen-relay/relay.cjs"]
