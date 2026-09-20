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
 * It survived because nothing ran it: `build:node` existed only on the AWS
 * deploy path, while `build` ran the Vercel path off `src/vercel.ts` and never
 * touched this file. That gap let a second defect land the same way — #3510
 * referenced a `BUNDLES` list it never defined, so `build-node.mjs` threw
 * `ReferenceError` after bundling and every api deploy would have failed at the
 * packaging step. `build` now runs `build-node.mjs` itself, so the build that
 * ships is the build CI runs, and a broken bundler fails in `turbo run build`
 * rather than first in a deploy.
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
const BACKFILL = fileURLToPath(
  new URL("../scripts/cms-crm-backfill.ts", import.meta.url),
);
const BUILD_NODE = fileURLToPath(
  new URL("../../build-node.mjs", import.meta.url),
);

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

  it("the CRM backfill script transforms to CJS too (it ships beside the server)", async () => {
    // build-node.mjs bundles src/scripts/cms-crm-backfill.ts to
    // dist/cms-crm-backfill.cjs so the node can run it with `docker exec`.
    // The script ends in `main().catch(...)`, not a top-level await, and
    // this keeps it that way.
    const source = await readFile(BACKFILL, "utf8");
    await expect(
      transform(source, {
        loader: "ts",
        format: "cjs",
        platform: "node",
        target: "node22",
      }),
    ).resolves.toBeDefined();
  });

  it("build-node.mjs declares an entrypoint for every artifact the node runs", async () => {
    // The transform checks above prove each source COULD be bundled; they say
    // nothing about whether the bundler is asked to. #3510 documented
    // `dist/cms-crm-backfill.cjs` and added a `BUNDLES.map(...)` log line, but
    // never added the list — so the script was never emitted, and the undefined
    // reference threw after the server bundle was already written. Reading the
    // build script is the cheap half of the guard; the expensive half is that
    // `pnpm --filter @oxagen/api build` now runs this bundler, so a list that
    // does not evaluate fails CI rather than a deploy.
    const source = await readFile(BUILD_NODE, "utf8");
    for (const outfile of ["server.cjs", "cms-crm-backfill.cjs"]) {
      expect(source).toContain(outfile);
    }
    expect(source).toMatch(/const BUNDLES = \[/);
  });
});
