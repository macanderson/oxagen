/**
 * The worker does not run its TypeScript: it runs one esbuild CJS bundle
 * (`build-node.mjs` → `dist/worker.cjs`), and CJS is where `import.meta` stops
 * existing. esbuild substitutes `{}` for it, so any module in the closure that
 * reads `import.meta.url` gets `undefined` and throws the moment it is
 * initialized — before a single line of worker code runs.
 *
 * That is not hypothetical. It shipped: #2567 introduced this bundle with the
 * `empty-import-meta` warning silenced, `@oxagen/stella-engine-client` resolved
 * its sidecar config from `import.meta.url`, and every worker deploy since
 * failed its health check on the node with `ERR_INVALID_ARG_TYPE`. The deploy
 * step was `continue-on-error`, so CI reported green, and the node had no
 * previous release to roll back to — the worker was simply down.
 *
 * Unit tests could not see it. They import the TypeScript directly, as ESM,
 * where `import.meta.url` is a real URL and everything passes. The bundle is a
 * different artifact with different semantics, so this test builds that
 * artifact and boots it in a cold Node process, the way the node does.
 *
 * The entry imports `@oxagen/agent-runner/stella` because that is the edge the
 * crash came in through — worker → agent-runner/stella → stella-engine-client —
 * rather than reaching past it to the failing package directly.
 *
 * Booting is the assertion, deliberately, rather than failing the build on the
 * `empty-import-meta` warning. `import.meta` has correct guarded uses in this
 * repository (connector-schema-loader.ts falls back to `__dirname`,
 * is-direct-run.ts tolerates `undefined`), and esbuild cannot tell a guarded
 * use from an unguarded one — it only sees the syntax. Running the bundle can:
 * a guarded use boots fine, an unguarded one at module scope throws.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { build } from "esbuild";

// Inside the package, not the OS temp dir: esbuild resolves bare specifiers by
// walking up from the entry file, so an entry outside the workspace cannot see
// the workspace's node_modules. `node_modules/` is already ignored by git.
const workdir = mkdtempSync(
  join(process.cwd(), "node_modules", ".cjs-witness-"),
);
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe("the worker's CJS bundle", () => {
  test("boots the stella engine client without import.meta", async () => {
    const entry = join(workdir, "entry.ts");
    const outfile = join(workdir, "bundle.cjs");

    // A bare side-effect import is the whole test: the defect threw during
    // module initialization, so nothing needs to be called for it to reproduce.
    writeFileSync(
      entry,
      `import "@oxagen/agent-runner/stella";\n` + `console.log("BOOTED");\n`,
    );

    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      logLevel: "silent",
      external: [
        "pg-native",
        "better-sqlite3",
        "dockerode",
        "aws-sdk",
        "nock",
        "mock-aws-s3",
        "@mapbox/node-pre-gyp",
        "duckdb",
      ],
    });

    const stdout = execFileSync(process.execPath, [outfile], {
      encoding: "utf8",
    });
    expect(stdout).toContain("BOOTED");
  }, 120_000);
});
