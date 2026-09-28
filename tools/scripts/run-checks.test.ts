/**
 * The runner that replaced the `checks` job's eight-command `&&` chain (#3428).
 *
 * The chain stopped at the first failure, so a later failure stayed hidden
 * until the next CI cycle. The witness below gives the runner one passing
 * and two failing checks and asserts it ran all three and named both
 * failures.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapeData,
  escapeProperty,
  isEntrypoint,
  runChecks,
  summaryLines,
} from "./run-checks.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "run-checks.mjs");

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

  it("runs when node starts it through a symlink", () => {
    // Node resolves symlinks in import.meta.url but not in argv[1], so the
    // `file://${argv[1]}` comparison the other guards use reads false here.
    const dir = mkdtempSync(join(tmpdir(), "run-checks-"));
    try {
      const link = join(dir, "run-checks.mjs");
      symlinkSync(RUNNER, link);
      const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
      expect(result.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads false for another script and for no script", () => {
    expect(isEntrypoint(undefined)).toBe(false);
    expect(isEntrypoint(fileURLToPath(import.meta.url))).toBe(false);
    expect(isEntrypoint("/no/such/file.mjs")).toBe(false);
  });
});
