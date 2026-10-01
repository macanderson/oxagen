// These tests start each script that guards its body with `isEntrypoint` as a
// child process, and each child reads the live repository tree. vitest.config.ts
// leaves *.tree.test.ts files out of turbo's cached tasks, so
// `pnpm check:tree-guards` runs them uncached in the checks job (#4664 item 2).
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "is-entrypoint-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Case {
  /** The script under tools/scripts. */
  file: string;
  args: string[];
  env?: Record<string, string>;
  /** Run in an empty directory instead of the repository. */
  emptyCwd?: boolean;
  /** Proof the direct run got past its entrypoint check. */
  ran: { status?: number; output: string };
}

// Each script reaches a line only a started script prints: a usage error, a
// missing input, or its verdict. None of them reads the network.
const CASES: Case[] = [
  {
    file: "run-checks.mjs",
    args: [],
    ran: { status: 2, output: "name at least one pnpm script" },
  },
  {
    file: "check-coverage-scope.mjs",
    args: [],
    ran: { status: 2, output: "usage: node tools/scripts/check-coverage-scope.mjs" },
  },
  {
    file: "check-coverage-scope.mjs",
    args: ["apps/app"],
    emptyCwd: true,
    ran: { status: 1, output: "coverage-scope: no report at" },
  },
  {
    file: "hook-preflight.mjs",
    args: [],
    ran: { status: 2, output: "usage: node tools/scripts/hook-preflight.mjs" },
  },
  {
    file: "check-closing-keywords.mjs",
    args: [],
    ran: { status: 2, output: "usage: check-closing-keywords.mjs" },
  },
  {
    file: "scr-dod-check.mjs",
    args: [],
    ran: { status: 2, output: "usage: scr-dod-check.mjs" },
  },
  {
    file: "check-superseded-runs.mjs",
    args: [],
    env: { PR_NUMBER: "", HEAD_REPO: "", HEAD_BRANCH: "" },
    ran: { status: 0, output: "[ci-superseded] No open pull request" },
  },
  {
    file: "check-checks-job-continues.mjs",
    args: [],
    ran: { output: "check-checks-job-continues:" },
  },
  {
    file: "check-main-concurrency.mjs",
    args: [],
    ran: { output: "check-main-concurrency:" },
  },
  {
    file: "check-adr-index.mjs",
    args: [],
    ran: { output: "check-adr-index:" },
  },
  {
    file: "check-action-pins.mjs",
    args: [],
    ran: { output: "check-action-pins:" },
  },
  {
    file: "sync-brand-assets.mjs",
    args: ["--check", "--brand", "/no/such/kit"],
    // Off CI too: a check with no kit fails rather than skipping (#4804).
    env: { CI: "" },
    ran: { status: 2, output: "brand: FAILED" },
  },
  {
    file: "sync-brand-assets.mjs",
    args: ["--check", "--brand", "/no/such/kit"],
    env: { CI: "true" },
    ran: { status: 2, output: "brand: FAILED" },
  },
  {
    file: "check-role-enforcement.mjs",
    args: [],
    ran: { output: "check-role-enforcement" },
  },
];

describe.each(CASES)("$file $args", ({ file, args, env, emptyCwd, ran }) => {
  const script = join(SCRIPTS_DIR, file);
  const start = (path: string) => {
    const result = spawnSync(process.execPath, [path, ...args], {
      encoding: "utf8",
      cwd: emptyCwd ? mkdtempSync(join(scratch, "cwd-")) : undefined,
      env: { ...process.env, ...env },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  };

  it(
    "runs when node starts it directly",
    () => {
      const direct = start(script);
      if (ran.status !== undefined) expect(direct.status).toBe(ran.status);
      expect(direct.output).toContain(ran.output);
    },
    60_000,
  );

  it(
    "runs the same when node starts it through a symlink",
    () => {
      const dir = mkdtempSync(join(scratch, "link-"));
      const link = join(dir, file);
      symlinkSync(script, link);
      const direct = start(script);
      const linked = start(link);
      expect(linked.output).toContain(ran.output);
      expect(linked.status).toBe(direct.status);
    },
    60_000,
  );
});

// Every script above finds its entrypoint through the shared helper, so the
// symlink fix cannot drift between copies again.
describe("the scripts use the shared helper", () => {
  const files = [...new Set(CASES.map((c) => c.file))];

  it.each(files)("%s", (file) => {
    const src = readFileSync(join(SCRIPTS_DIR, file), "utf8");
    expect(src).toContain('from "./lib/is-entrypoint.mjs"');
    expect(src).not.toMatch(/argv\[1\]\s*(===|&&|\))/);
    expect(src).not.toContain("pathToFileURL(process.argv[1])");
  });
});
