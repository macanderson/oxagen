/**
 * pr.test.ts — unit tests for `oxagen pr status|watch|fix`.
 *
 * Everything external is mocked at its module seam: `gh` calls via ./gh.js,
 * git via node:child_process, the engine session, the fix runner, and the
 * fix loop itself (../lib/pr-fix.js) — whose captured `deps` argument is also
 * how the real `fetchFailingContext` / git callbacks get exercised. The
 * pr-monitor fold is pure and runs real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ghMock = vi.hoisted(() => ({
  runGh: vi.fn(),
  ghJson: vi.fn(),
}));
vi.mock("./gh.js", () => ghMock);

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const sessionMock = vi.hoisted(() => ({
  requireSession: vi.fn(() => ({ token: "t", orgSlug: "o", workspaceSlug: "w" })),
}));
vi.mock("../lib/session.js", () => sessionMock);

const runnerMock = vi.hoisted(() => ({
  runFixer: vi.fn(),
  rememberOutcome: vi.fn(),
}));
vi.mock("../agent/pr-fix-runner.js", () => ({
  createPrFixRunner: vi.fn(() => runnerMock),
}));

const fixMock = vi.hoisted(() => ({
  runFixToGreen: vi.fn(),
  MAX_FAILING_CHECKS_TO_DIAGNOSE: 3,
}));
vi.mock("../lib/pr-fix.js", () => fixMock);

import { fetchPr, handlePrFix, handlePrStatus, handlePrWatch } from "./pr.js";

const PASS = { name: "build", conclusion: "SUCCESS" };
const FAIL = {
  name: "test",
  conclusion: "FAILURE",
  detailsUrl: "https://github.com/acme/repo/actions/runs/11/job/22",
};
const PENDING = { name: "e2e", conclusion: null, state: null };

const prView = (rollup: unknown[] = [PASS]) => ({
  number: 7,
  state: "OPEN",
  title: "fix the thing",
  headRefName: "fix/thing",
  url: "https://github.com/acme/repo/pull/7",
  statusCheckRollup: rollup,
});

/** `promisify(execFile)` consumes the node-style callback custom symbol; the
 * plain mock has none, so promisify treats the last arg as the callback. */
const execOk = (stdout: string) =>
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (e: unknown, r: { stdout: string; stderr: string }) => void,
    ) => {
      const done = typeof _opts === "function" ? (_opts as typeof cb) : cb;
      done?.(null, { stdout, stderr: "" });
    },
  );

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr.push(String(s));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("fetchPr", () => {
  it("asks gh for the current branch's PR when no number is given", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView());
    const pr = await fetchPr();
    expect(pr?.number).toBe(7);
    expect(ghMock.ghJson).toHaveBeenCalledWith([
      "pr",
      "view",
      "--json",
      "number,state,title,headRefName,url,statusCheckRollup",
    ]);
  });

  it("passes an explicit number through", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView());
    await fetchPr("41");
    expect(ghMock.ghJson.mock.calls[0]?.[0]).toContain("41");
  });

  it("maps gh's no-PR errors to null and rethrows anything else", async () => {
    ghMock.ghJson.mockRejectedValueOnce(
      new Error("no pull requests found for branch"),
    );
    expect(await fetchPr()).toBeNull();
    ghMock.ghJson.mockRejectedValueOnce(new Error("gh: network unreachable"));
    await expect(fetchPr()).rejects.toThrow("network unreachable");
  });
});

describe("handlePrStatus", () => {
  it("prints the human summary and exits 0 on green", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([PASS, PASS]));
    await handlePrStatus(undefined, {});
    expect(stdout.join("")).toContain("PR #7 fix the thing");
    expect(stdout.join("")).toContain("all 2 checks passed");
    expect(process.exitCode).toBe(0);
  });

  it("lists each failing check with its url and exits 1", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([PASS, FAIL]));
    await handlePrStatus(undefined, {});
    expect(stdout.join("")).toContain("✗ test");
    expect(stdout.join("")).toContain(FAIL.detailsUrl);
    expect(process.exitCode).toBe(1);
  });

  it("exits 2 while checks are pending, and emits JSON when asked", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([PENDING]));
    await handlePrStatus(undefined, { json: true });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed).toMatchObject({ number: 7, state: "pending", pending: 1 });
    expect(process.exitCode).toBe(2);
  });

  it("says so and exits 1 when there is no PR", async () => {
    ghMock.ghJson.mockResolvedValueOnce(null);
    await handlePrStatus(undefined, {});
    expect(stderr.join("")).toContain("No pull request found");
    expect(process.exitCode).toBe(1);
  });
});

describe("handlePrWatch", () => {
  it("reports green, offers the merge command, and exits 0", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([PASS]));
    await handlePrWatch(undefined, {});
    expect(stdout.join("")).toContain("PR #7 is GREEN");
    expect(stdout.join("")).toContain("oxagen pr watch 7 --merge");
    expect(process.exitCode).toBe(0);
  });

  it("--merge squash-merges once green and exits 0", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([PASS]));
    ghMock.runGh.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await handlePrWatch(undefined, { merge: true });
    expect(ghMock.runGh).toHaveBeenCalledWith([
      "pr",
      "merge",
      "7",
      "--squash",
      "--delete-branch",
    ]);
    expect(process.exitCode).toBe(0);
  });

  it("a failed merge is exit 1, never a false success", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([PASS]));
    ghMock.runGh.mockRejectedValueOnce(new Error("merge conflict"));
    await handlePrWatch(undefined, { merge: true });
    expect(stderr.join("")).toContain("Merge failed: merge conflict");
    expect(process.exitCode).toBe(1);
  });

  it("reports failing checks and exits 1", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([FAIL]));
    await handlePrWatch(undefined, {});
    expect(stdout.join("")).toContain("PR #7 is FAILING: test");
    expect(process.exitCode).toBe(1);
  });

  it("a PR with no checks is terminal with exit 0", async () => {
    ghMock.ghJson.mockResolvedValueOnce(prView([]));
    await handlePrWatch(undefined, {});
    expect(stdout.join("")).toContain("no checks to wait on");
    expect(process.exitCode).toBe(0);
  });

  it("keeps polling past a pending read and settles on the terminal one", async () => {
    vi.useFakeTimers();
    ghMock.ghJson
      .mockResolvedValueOnce(prView([PENDING]))
      .mockResolvedValueOnce(prView([PASS]));
    const done = handlePrWatch(undefined, { interval: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    vi.useRealTimers();
    expect(stdout.join("")).toContain("PR #7 is GREEN");
    expect(ghMock.ghJson).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(0);
  });
});

describe("handlePrFix", () => {
  const fixResult = (outcome: string, extra: Record<string, unknown> = {}) => ({
    outcome,
    pr: { number: 7, url: "https://github.com/acme/repo/pull/7" },
    rounds: [],
    ...extra,
  });

  beforeEach(() => {
    execOk("fix/thing\n"); // every git call in these paths reads the branch
    ghMock.ghJson.mockResolvedValue(prView([FAIL]));
  });

  it("refuses to run from a checkout that is not the PR's branch", async () => {
    execOk("main\n");
    await handlePrFix(undefined, {});
    expect(stderr.join("")).toContain('current checkout is on "main"');
    expect(fixMock.runFixToGreen).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 with the standard message when there is no PR", async () => {
    ghMock.ghJson.mockReset().mockResolvedValueOnce(null);
    await handlePrFix(undefined, {});
    expect(stderr.join("")).toContain("No pull request found");
    expect(process.exitCode).toBe(1);
  });

  it("a merged outcome mirrors a bug-root-cause lesson and exits 0", async () => {
    fixMock.runFixToGreen.mockResolvedValueOnce(
      fixResult("merged", {
        rounds: [
          { round: 1, failing: ["test"], diagnosis: "the fix", filesChanged: ["a.ts"] },
        ],
      }),
    );
    await handlePrFix(undefined, {});
    expect(stdout.join("")).toContain("green and merged");
    expect(runnerMock.rememberOutcome).toHaveBeenCalledWith(
      "bug-root-cause",
      expect.objectContaining({ files: ["a.ts"] }),
    );
    expect(process.exitCode).toBe(0);
  });

  it.each([
    ["merge-declined", 0, "Not merged (declined)"],
    ["merge-failed", 1, "merge failed"],
    ["no-change", 1, "no changes"],
    ["timed-out", 2, "gave up waiting"],
    ["no-checks", 0, "no checks to fix"],
    ["no-pr", 1, "No pull request found"],
  ] as const)("outcome %s exits %i", async (outcome, code, phrase) => {
    fixMock.runFixToGreen.mockResolvedValueOnce(fixResult(outcome));
    await handlePrFix(undefined, {});
    expect((stdout.join("") + stderr.join("")).toLowerCase()).toContain(
      phrase.toLowerCase(),
    );
    expect(process.exitCode).toBe(code);
  });

  it.each([["max-rounds"], ["unfixable"]] as const)(
    "outcome %s mirrors a gotcha lesson and exits 1",
    async (outcome) => {
      fixMock.runFixToGreen.mockResolvedValueOnce(fixResult(outcome));
      await handlePrFix(undefined, {});
      expect(runnerMock.rememberOutcome).toHaveBeenCalledWith(
        "gotcha",
        expect.anything(),
      );
      expect(process.exitCode).toBe(1);
    },
  );

  it("hands the loop working callbacks: onRound prints, fetchFailingContext pulls gh logs", async () => {
    interface CapturedDeps {
      fetchFailingContext: (
        pr: { number: number; url: string },
        failing: Array<{ name: string; url?: string }>,
      ) => Promise<string>;
      onStatus: (line: string) => void;
      onRound: (round: {
        round: number;
        failing: string[];
        diagnosis: string;
        filesChanged: string[];
      }) => void;
    }
    let deps!: CapturedDeps;
    fixMock.runFixToGreen.mockImplementationOnce(async (d: unknown) => {
      deps = d as CapturedDeps;
      deps.onStatus("polling");
      deps.onRound({
        round: 1,
        failing: ["test"],
        diagnosis: "root cause\nsecond line",
        filesChanged: [],
      });
      return fixResult("no-checks");
    });
    await handlePrFix(undefined, {});
    expect(stderr.join("")).toContain("polling");
    expect(stdout.join("")).toContain("Round 1: fixing test");
    expect(stdout.join("")).toContain("  root cause");
    expect(stdout.join("")).toContain("no files changed");

    // fetchFailingContext: annotations + failed log via gh, bounded and joined.
    ghMock.ghJson.mockResolvedValueOnce([
      { message: "boom", path: "src/x.ts", start_line: 3 },
    ]);
    ghMock.runGh.mockResolvedValueOnce({ stdout: "log tail here", stderr: "" });
    const context = await deps.fetchFailingContext(
      { number: 7, url: "https://github.com/acme/repo/pull/7" },
      [{ name: "test", url: FAIL.detailsUrl }],
    );
    expect(context).toContain("### test");
    expect(context).toContain("src/x.ts:3: boom");
    expect(context).toContain("log tail here");
    expect(ghMock.ghJson).toHaveBeenCalledWith([
      "api",
      "repos/acme/repo/check-runs/22/annotations",
    ]);

    // A check with no parsable run/job URL contributes nothing.
    expect(
      await deps.fetchFailingContext(
        { number: 7, url: "https://github.com/acme/repo/pull/7" },
        [{ name: "vercel", url: "https://vercel.com/deploy/123" }],
      ),
    ).toBe("");

    // A PR whose URL is not github.com/<owner>/<repo>/pull/ yields nothing.
    expect(
      await deps.fetchFailingContext({ number: 7, url: "https://example.test" }, [
        { name: "test", url: FAIL.detailsUrl },
      ]),
    ).toBe("");
  });
});
