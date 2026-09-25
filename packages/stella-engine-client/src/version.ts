/**
 * The `stella-serve` release Oxagen runs. This is the one place its version
 * is written.
 *
 * Three things read it. `tools/scripts/package-for-node.sh` names the image
 * the node runs, `ghcr.io/macanderson/stella-serve:<this version>`. Every
 * assistant run records it as the engine version on its attempt
 * (`ASSISTANT_ENGINE` in `@oxagen/agent`). The smoke test refuses a binary
 * older than it. `docker-compose.dev.yml` cannot read this file, so
 * `tools/scripts/check-engine-version.mjs` fails `pnpm check:contracts` when
 * any tracked image tag differs from it.
 *
 * The wire types under `src/generated/` were copied from Stella at 0.9.411.
 * Stella's `docs/wire` did not change between 0.9.411 and 0.9.414, the first
 * release published as an image for both architectures (#2833). A newer
 * server may add frames and fields. A client built here keeps reading them,
 * because unknown tags pass through, but claims nothing about them.
 *
 * Bump it with the steps in this package's README.
 */
export const STELLA_SERVE_PINNED_VERSION = "0.9.414";
