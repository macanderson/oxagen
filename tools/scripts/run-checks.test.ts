/**
 * The runner that replaced the `checks` job's eight-command `&&` chain (#3428),
 * and `check:contracts`'s 26-command one (#4664 item 9).
 *
 * The chain stopped at the first failure, so a later failure stayed hidden
 * until the next CI cycle. The witness below gives the runner one passing
 * and two failing checks and asserts it ran all three and named both
 * failures.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapeData,
  escapeProperty,
  outputMode,
  runChecks,
  summaryLines,
} from "./run-checks.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "run-checks.mjs");
const TOP = { groups: true, annotate: true, parent: undefined };

describe("runChecks", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs every check after a failure and names each failure", () => {
    const ran: string[] = [];
    const statuses: Record<string, number> = {
      "check:manifest": 1,
      "check:contracts": 0,
      "docs:architecture:check": 2,
    };
    const outcome = runChecks(Object.keys(statuses), (name: string) => {
      ran.push(name);
      return statuses[name] ?? 1;
    });

    // An `&&` chain would have stopped after check:manifest.
    expect(ran).toEqual([
      "check:manifest",
      "check:contracts",
      "docs:architecture:check",
    ]);
    expect(outcome.failed).toEqual([
      "check:manifest",
      "docs:architecture:check",
    ]);
  });

  it("reports no failure when every check passes", () => {
    const outcome = runChecks(["a", "b"], () => 0);
    expect(outcome.failed).toEqual([]);
    expect(summaryLines(outcome)).toContain("All 2 checks passed.");
  });

  it("counts any non-zero status as failed", () => {
    // 137 is what a runner reports for a check the kernel killed for memory.
    // A runner that compared with `=== 1` would read it as a pass.
    const outcome = runChecks(["killed"], () => 137);
    expect(outcome.failed).toEqual(["killed"]);
  });
});

describe("summaryLines", () => {
  it("lists every check and one error annotation per failure", () => {
    const lines = summaryLines({
      results: [
        { name: "check:manifest", status: 1 },
        { name: "env:check", status: 0 },
        { name: "check:inngest-senders", status: 1 },
      ],
      failed: ["check:manifest", "check:inngest-senders"],
    });
    expect(lines).toContain("  FAIL  check:manifest (exit 1)");
    expect(lines).toContain("  pass  env:check");
    expect(lines).toContain(
      "2 of 3 checks failed: check:manifest, check:inngest-senders",
    );
    expect(lines.filter((l) => l.startsWith("::error "))).toHaveLength(2);
  });
});

describe("workflow command escaping", () => {
  it("escapes the colon in a check name so the title is not split", () => {
    const lines = summaryLines({
      results: [{ name: "check:manifest", status: 1 }],
      failed: ["check:manifest"],
    });
    const annotation = lines.find((l) => l.startsWith("::error "));
    expect(annotation).toMatch(/^::error title=check%3Amanifest failed::pnpm /);
  });

  it("escapes percent signs, newlines, colons and commas as @actions/core does", () => {
    expect(escapeProperty("a:b,c%\n")).toBe("a%3Ab%2Cc%25%0A");
    expect(escapeData("50%\r\nnext: line")).toBe("50%25%0D%0Anext: line");
  });
});

describe("check:contracts", () => {
  // Reads the root package.json, which tools/scripts/turbo.json declares as
  // an input of this package's tests (#4664 item 2).
  // check-checks-job-continues.mjs holds the same property live, inside
  // check:contracts, on every CI run.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const scripts: Record<string, string> = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  const command = scripts["check:contracts"] ?? "";
  const names = command.split(/\s+/).slice(2);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a run-checks list of root scripts, not an && chain", () => {
    expect(command.startsWith("node tools/scripts/run-checks.mjs ")).toBe(true);
    expect(command).not.toContain("&&");
    expect(names.filter((name) => scripts[name] === undefined)).toEqual([]);
    // Spot checks that the guards the chain ran are still listed.
    expect(names).toContain("check:role-enforcement");
    expect(names).toContain("check:deploy-tip");
    expect(names).toContain("docs:schemas:check");
  });

  it("reports two planted guard failures in one run", () => {
    // The old chain stopped at the first of these and never reached the
    // second, the last guard in the list.
    const planted = new Set(["check:adr-index", "docs:schemas:check"]);
    const ran: string[] = [];
    const outcome = runChecks(
      names,
      (name: string) => {
        ran.push(name);
        return planted.has(name) ? 1 : 0;
      },
      TOP,
    );
    expect(ran).toEqual(names);
    expect(outcome.failed).toEqual(["check:adr-index", "docs:schemas:check"]);
    expect(summaryLines(outcome, TOP)).toContain(
      `2 of ${names.length} checks failed: check:adr-index, docs:schemas:check`,
    );
  });
});

describe("outputMode", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("groups and annotates only at the top level on GitHub Actions", () => {
    expect(outputMode({ GITHUB_ACTIONS: "true" })).toEqual(TOP);
    expect(
      outputMode({ GITHUB_ACTIONS: "true", RUN_CHECKS_PARENT: "check:contracts" }),
    ).toEqual({ groups: false, annotate: true, parent: "check:contracts" });
    expect(outputMode({})).toEqual({
      groups: false,
      annotate: false,
      parent: undefined,
    });
  });

  it("prints no group markers inside another runner's group", () => {
    // GitHub does not nest log groups: an inner ::group:: would end the outer
    // check:contracts group partway through.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runChecks(["check:adr-index"], () => 0, {
      groups: false,
      annotate: true,
      parent: "check:contracts",
    });
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed.some((l) => l.includes("::group::"))).toBe(false);
    expect(printed).toContain("\n=== check:adr-index");
  });

  it("points a nested failure at the outer group and drops annotations off Actions", () => {
    const outcome = {
      results: [{ name: "check:adr-index", status: 1 }],
      failed: ["check:adr-index"],
    };
    const nested = summaryLines(outcome, {
      annotate: true,
      parent: "check:contracts",
    });
    expect(nested.find((l) => l.startsWith("::error "))).toContain(
      '=== check:adr-index" in the "check:contracts" group',
    );
    const local = summaryLines(outcome, { annotate: false, parent: undefined });
    expect(local.some((l) => l.startsWith("::error "))).toBe(false);
    expect(local).toContain("1 of 1 checks failed: check:adr-index");
  });
});

describe("entrypoint", () => {
  // The step in pipeline.yml runs `node tools/scripts/run-checks.mjs ...`.
  // If the entrypoint test misread that as an import, the script would exit
  // 0 having run nothing and the CI step would pass green. With no check
  // named, a script that did start exits 2.
  it("runs when node starts it directly", () => {
    const result = spawnSync(process.execPath, [RUNNER], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("name at least one pnpm script");
  });

  // lib/is-entrypoint.tree.test.ts starts this runner, and each guard that shares
  // its entrypoint test, through a symlink.
});
