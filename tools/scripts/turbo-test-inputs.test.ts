// #4664 item 2: turbo hashes a test task over its own package. A test that
// reads a file from another package, or from the repository root, therefore
// keeps its cache key when that file changes, and main restores a pass the
// test did not earn. Each package below declares those files as inputs of its
// test tasks in its own turbo.json. This test holds that declaration.
//
// Not covered, because declaring them would turn off the suite's cache: the
// tools/scripts guards that scan every package's source
// (tool-invocation-execution-identity, audit-emit-consolidation,
// gen-architecture-docs, check-capability-docs), and check-deregistered's
// reads of the paths DEREGISTERED.md lists.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Each package's tests, and the files outside the package each one reads, as
 * paths from the repository root.
 */
const OUTSIDE_READS: Record<string, Record<string, string[]>> = {
  "packages/handlers": {
    "src/role-check.test.ts": [
      "tools/scripts/lib/role-gate-ast.mjs",
      "tools/scripts/lib/role-gate-ast.d.mts",
    ],
    "src/mcp-studio/project.test.ts": [
      "packages/mcp-studio/fixtures/expected/tool-manifest.json",
    ],
    "src/mcp-studio/import/draft.save.test.ts": [
      "packages/mcp-studio/fixtures/servers/billing/server.toml",
    ],
  },
  "apps/web": {
    "scripts/lib/theme.test.mjs": ["packages/ui/src/styles/house-tokens.json"],
  },
  "tools/scripts": {
    "root-hook-deps.test.ts": ["package.json", "lefthook.yml"],
    "run-checks.test.ts": ["package.json"],
    "check-checks-job-continues.test.ts": [
      ".github/workflows/pipeline.yml",
      "package.json",
    ],
    "hook-preflight.test.ts": ["package.json"],
    "typecheck-staged-plan.test.ts": [
      "apps/app/package.json",
      "apps/app_deprecated/package.json",
      "apps/docs/package.json",
    ],
    // lib/archdocs/collect.ts imports the manifest hash from @oxagen/database
    // by a relative path. The atlas's other reads span the whole tree and stay
    // uncovered, as the header says.
    "gen-architecture-docs.test.ts": [
      "packages/database/src/storage-manifest/canonical-json.ts",
    ],
    "check-coverage-scope.test.ts": [
      ".github/workflows/pipeline.yml",
      "apps/app/vitest.config.ts",
    ],
    "check-superseded-runs.test.ts": [
      ".github/workflows/ci-superseded.yml",
      ".github/workflows/pipeline.yml",
    ],
    "shared-cells.test.ts": ["AGENTS.md", ".github/workflows/pipeline.yml"],
    "check-closing-keywords.test.ts": [".github/workflows/dod-check.yml"],
    "inngest-verify.test.ts": [".github/workflows/pipeline.yml"],
    "release-artifacts.test.ts": [".github/workflows/desktop.yml"],
    "sync-brand-assets.test.ts": [
      "apps/web/scripts/lib/theme.mjs",
      ".github/workflows/pipeline.yml",
      "package.json",
    ],
    "gen-capability-schemas.test.ts": [
      "docs/capabilities/schemas/set_price_entry.json",
    ],
    "tacho-ingress-alarm.test.ts": ["infra/stacks-new/oxagen/alarms.tf"],
    "packaging.test.ts": [
      "tools/packaging/checksums.mjs",
      "tools/packaging/stamp.mjs",
    ],
    "gen-rls-migration.test.ts": [
      "packages/database/src/tenant-policy.manifest.ts",
    ],
    "check-engine-version.test.ts": [
      "packages/stella-engine-client/src/version.ts",
    ],
    "check-deregistered.test.ts": ["DEREGISTERED.md"],
  },
};

/** A turbo.json, with its full-line `//` comments removed. */
function readTurbo(path: string) {
  const text = readFileSync(join(REPO_ROOT, path), "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return JSON.parse(text) as {
    extends?: string[];
    tasks: Record<string, { inputs?: string[] }>;
  };
}

/** A turbo input glob as a regex over repository paths. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const root = readTurbo("turbo.json");
const TASKS = ["test:unit", "test:coverage"] as const;

describe.each(Object.entries(OUTSIDE_READS))("%s", (pkg, reads) => {
  const config = readTurbo(`${pkg}/turbo.json`);

  it("extends the root config", () => {
    expect(config.extends).toEqual(["//"]);
  });

  it.each(TASKS)("keeps every root input of %s", (task) => {
    expect(config.tasks[task]?.inputs).toEqual(
      expect.arrayContaining(root.tasks[task]?.inputs ?? []),
    );
  });

  describe.each(Object.entries(reads))("%s", (testFile, files) => {
    it("exists, and so does each file it reads", () => {
      expect(existsSync(join(REPO_ROOT, pkg, testFile))).toBe(true);
      for (const file of files) expect(existsSync(join(REPO_ROOT, file))).toBe(true);
    });

    it.each(TASKS)("declares each file as an input of %s", (task) => {
      const globs = (config.tasks[task]?.inputs ?? [])
        .filter((input) => input.startsWith("$TURBO_ROOT$/"))
        .map((input) => globToRegExp(input.slice("$TURBO_ROOT$/".length)));
      for (const file of files) {
        expect(
          globs.some((glob) => glob.test(file)),
          `${file} is not an input of ${pkg}'s ${task}`,
        ).toBe(true);
      }
    });
  });
});
