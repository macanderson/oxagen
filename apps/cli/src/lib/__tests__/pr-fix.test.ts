/**
 * pr-fix — the fix-to-green loop's control flow, fully decoupled from GitHub,
 * git, and the model: every effect (`fetchPr`, the fixer turn, git, the merge
 * prompt) is a fake injected via {@link PrFixDeps}. Covers the required
 * scenarios: fail → fix → re-check → green (with and without merge
 * confirmation), the max-rounds safety cap, the no-change early stop, and the
 * unfetchable-context ("infra flake") early stop.
 */
import { describe, it, expect, vi } from "vitest";
import { runFixToGreen, type PrFixDeps, type FixPrView } from "../pr-fix.js";
import type { CheckRollupItem } from "../pr-monitor.js";

function makePr(
  statusCheckRollup: CheckRollupItem[],
  overrides: Partial<FixPrView> = {},
): FixPrView {
  return {
    number: 1,
    title: "Test PR",
    url: "https://github.com/acme/widgets/pull/1",
    headRefName: "feat/x",
    statusCheckRollup,
    ...overrides,
  };
}

const FAILING_CHECK: CheckRollupItem[] = [
  {
    name: "test",
    conclusion: "FAILURE",
    detailsUrl: "https://github.com/acme/widgets/actions/runs/1/job/2",
  },
];
const GREEN_CHECK: CheckRollupItem[] = [
  { name: "test", conclusion: "SUCCESS" },
];
const PENDING_CHECK: CheckRollupItem[] = [
  { name: "test", conclusion: null, state: "PENDING" },
];

/** A `fetchPr` fake that returns each of `results` in order, then repeats the last one. */
function fetchPrSequence(
  ...results: Array<FixPrView | null>
): PrFixDeps["fetchPr"] {
  let i = 0;
  return vi.fn(async () => results[Math.min(i++, results.length - 1)] ?? null);
}

function baseDeps(overrides: Partial<PrFixDeps> = {}): PrFixDeps {
  return {
    fetchPr: vi.fn(async () => null),
    fetchFailingContext: vi.fn(async () => "TypeError: boom at src/foo.ts:10"),
    runFixer: vi.fn(async () => ({
      text: "Fixed the type error in src/foo.ts.",
    })),
    changedFiles: vi.fn(async () => ["src/foo.ts"]),
    commitAndPush: vi.fn(async () => {}),
    confirmMerge: vi.fn(async () => true),
    mergePr: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runFixToGreen", () => {
  it("fail → fix → re-check → green, then merges once the user confirms", async () => {
    const deps = baseDeps({
      fetchPr: fetchPrSequence(makePr(FAILING_CHECK), makePr(GREEN_CHECK)),
    });

    const result = await runFixToGreen(deps, { number: "1" });

    expect(result.outcome).toBe("merged");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.failing).toEqual(["test"]);
    expect(result.rounds[0]?.filesChanged).toEqual(["src/foo.ts"]);
    expect(deps.fetchFailingContext).toHaveBeenCalledTimes(1);
    expect(deps.runFixer).toHaveBeenCalledTimes(1);
    expect(deps.commitAndPush).toHaveBeenCalledTimes(1);
    expect(deps.commitAndPush).toHaveBeenCalledWith(
      ["src/foo.ts"],
      expect.stringContaining("PR #1"),
    );
    expect(deps.confirmMerge).toHaveBeenCalledTimes(1);
    expect(deps.mergePr).toHaveBeenCalledTimes(1);
  });

  it("asks before merging and does NOT merge when the user declines", async () => {
    const deps = baseDeps({
      fetchPr: fetchPrSequence(makePr(FAILING_CHECK), makePr(GREEN_CHECK)),
      confirmMerge: vi.fn(async () => false),
    });

    const result = await runFixToGreen(deps, { number: "1" });

    expect(result.outcome).toBe("merge-declined");
    expect(deps.confirmMerge).toHaveBeenCalledTimes(1);
    expect(deps.mergePr).not.toHaveBeenCalled();
  });

  it("never calls mergePr before confirmMerge resolves true, even once green", async () => {
    // A stricter regression guard on top of the previous test: mergePr must not
    // fire eagerly / speculatively while the confirm prompt is pending.
    const order: string[] = [];
    const deps = baseDeps({
      fetchPr: fetchPrSequence(makePr(FAILING_CHECK), makePr(GREEN_CHECK)),
      confirmMerge: vi.fn(async () => {
        order.push("confirm");
        return true;
      }),
      mergePr: vi.fn(async () => {
        order.push("merge");
      }),
    });

    await runFixToGreen(deps, { number: "1" });

    expect(order).toEqual(["confirm", "merge"]);
  });

  it("stops at the max-rounds cap when still red, without ever merging", async () => {
    const deps = baseDeps({
      fetchPr: vi.fn(async () => makePr(FAILING_CHECK)),
    });

    const result = await runFixToGreen(deps, { number: "1", maxRounds: 3 });

    expect(result.outcome).toBe("max-rounds");
    expect(result.rounds).toHaveLength(3);
    expect(deps.runFixer).toHaveBeenCalledTimes(3);
    expect(deps.commitAndPush).toHaveBeenCalledTimes(3);
    expect(deps.confirmMerge).not.toHaveBeenCalled();
    expect(deps.mergePr).not.toHaveBeenCalled();
  });

  it("stops immediately (no commit) when a fix round changes nothing", async () => {
    const deps = baseDeps({
      fetchPr: vi.fn(async () => makePr(FAILING_CHECK)),
      changedFiles: vi.fn(async () => []),
    });

    const result = await runFixToGreen(deps, { number: "1" });

    expect(result.outcome).toBe("no-change");
    expect(result.rounds).toHaveLength(1);
    expect(deps.runFixer).toHaveBeenCalledTimes(1);
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it("stops immediately when no failing-check context can be fetched (infra flake)", async () => {
    const deps = baseDeps({
      fetchPr: vi.fn(async () => makePr(FAILING_CHECK)),
      fetchFailingContext: vi.fn(async () => "   "),
    });

    const result = await runFixToGreen(deps, { number: "1" });

    expect(result.outcome).toBe("unfixable");
    expect(deps.runFixer).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  it("polls through a pending state before acting on the terminal result", async () => {
    const deps = baseDeps({
      fetchPr: fetchPrSequence(makePr(PENDING_CHECK), makePr(GREEN_CHECK)),
    });

    const result = await runFixToGreen(deps, { number: "1" });

    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("merged");
    expect(result.rounds).toHaveLength(0); // never failing, so no fix round was needed
  });

  it("reports no-pr when the PR can't be found", async () => {
    const deps = baseDeps({ fetchPr: vi.fn(async () => null) });

    const result = await runFixToGreen(deps, { number: "999" });

    expect(result.outcome).toBe("no-pr");
    expect(deps.runFixer).not.toHaveBeenCalled();
  });

  it("reports no-checks and never fixes when the PR has no checks at all", async () => {
    const deps = baseDeps({ fetchPr: vi.fn(async () => makePr([])) });

    const result = await runFixToGreen(deps, { number: "1" });

    expect(result.outcome).toBe("no-checks");
    expect(deps.runFixer).not.toHaveBeenCalled();
  });

  it("surfaces a merge failure distinctly, without claiming success", async () => {
    const deps = baseDeps({
      fetchPr: fetchPrSequence(makePr(FAILING_CHECK), makePr(GREEN_CHECK)),
      mergePr: vi.fn(async () => {
        throw new Error("gh: merge conflict");
      }),
    });

    const result = await runFixToGreen(deps, { number: "1" });

    expect(result.outcome).toBe("merge-failed");
  });
});
