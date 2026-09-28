/**
 * The runner that replaced the `checks` job's eight-command `&&` chain (#3428).
 *
 * The chain stopped at the first failure, so a later failure stayed hidden
 * until the next CI cycle. The witness below gives the runner one passing
 * and two failing checks and asserts it ran all three and named both
 * failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks, summaryLines } from "./run-checks.mjs";

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
