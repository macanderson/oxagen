/**
 * Entrypoint tests — guard the self-hosted entrypoint against constructs the
 * CJS bundle cannot express.
 *
 * Regression context: `build-node.mjs` bundles `src/index.ts` to
 * `dist/server.cjs` with `format: "cjs"`, and esbuild rejects a top-level
 * `await` in that format outright — a build error, not a warning. `src/index.ts`
 * carried `await bootstrap()` at module scope, so `pnpm build:node` could not
 * produce an artifact at all and api.oxagen.sh had nothing to deploy.
 *
 * It survived because nothing ran it: `build:node` exists only on the AWS
 * deploy path, and the org's GitHub Actions has been billing-locked since
 * 2026-07-13, so that job has never executed. `build` (the Vercel path) uses
 * `src/vercel.ts` and never touches this file.
 *
 * This transforms the entrypoint alone rather than bundling it — the syntax
 * rejection happens at transform time, so the check costs milliseconds instead
 * of a full dependency-graph build, and it fails for exactly the reason the
 * real build would.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("apps/api self-hosted entrypoint", () => {
  it("transforms to CJS, the format build-node.mjs emits", async () => {
    const source = await readFile(ENTRYPOINT, "utf8");

    // Same format/platform/target triple as build-node.mjs. A top-level await
    // here throws with "Top-level await is currently not supported with the
    // cjs output format".
    await expect(
      transform(source, {
        loader: "ts",
        format: "cjs",
        platform: "node",
        target: "node22",
      }),
    ).resolves.toBeDefined();
  });
});
