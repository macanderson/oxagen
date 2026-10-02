/**
 * The decisions rerun-lost-runner.mjs makes before it touches GitHub: which
 * failed jobs lost their runner, and whether the run gets a rerun. The cases
 * most worth pinning down are the ones that must not rerun: a job that failed
 * on its own after printing the loss phrase, a run whose branch moved on, and
 * a run that already used its reruns.
 */
import { describe, expect, it } from "vitest";
import {
  decide,
  isRunnerLossMessage,
  lastErrorLine,
  lostRunner,
  MAX_RUN_ATTEMPT,
} from "./rerun-lost-runner.mjs";

// The tail of job 110905320352 (#5180): AWS reclaimed the spot instance 3m22s
// into "Lint and typecheck".
const SPOT_RECLAIM_LOG = [
  "2026-10-02T16:12:52.3821997Z $ eslint . --max-warnings 0",
  "2026-10-02T16:12:52.3822350Z ##[endgroup]",
  "2026-10-02T16:15:05.7828522Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.",
  "2026-10-02T16:15:05.8208035Z Cleaning up orphan processes",
].join("\n");

const OWN_FAILURE_LOG = [
  "2026-10-02T16:12:52.3821997Z $ vitest run",
  "2026-10-02T16:13:01.0000000Z ##[error]AssertionError: expected 1 to be 2",
  "2026-10-02T16:13:02.0000000Z ##[error]Process completed with exit code 1.",
].join("\n");

const LOST_COMMUNICATION =
  "The self-hosted runner: oxagen-large-x64-i-0abc lost communication with the server. Verify the machine is running and has a healthy network connection. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.";

const SHA = "62c12969c0ffee00000000000000000000000000";
const run = (extra: Record<string, unknown> = {}) => ({
  id: 37027349832,
  conclusion: "failure",
  run_attempt: 1,
  event: "push",
  head_branch: "main",
  head_sha: SHA,
  ...extra,
});
const checks = { id: 110905320352, name: "checks" };

describe("isRunnerLossMessage", () => {
  it("knows the shutdown and lost-communication messages", () => {
    expect(isRunnerLossMessage(SPOT_RECLAIM_LOG.split("\n")[2])).toBe(true);
    expect(isRunnerLossMessage(LOST_COMMUNICATION)).toBe(true);
  });

  it("does not match an ordinary failure, or nothing", () => {
    expect(
      isRunnerLossMessage("##[error]Process completed with exit code 1."),
    ).toBe(false);
    expect(isRunnerLossMessage(null)).toBe(false);
  });
});

describe("lastErrorLine", () => {
  it("returns the last error line, not the first", () => {
    expect(lastErrorLine(OWN_FAILURE_LOG)).toContain("exit code 1");
  });

  it("returns null for a log with no error line, or no log", () => {
    expect(lastErrorLine("2026-10-02T16:00:00Z all good")).toBeNull();
    expect(lastErrorLine(null)).toBeNull();
  });
});

describe("lostRunner", () => {
  it("calls a spot reclaim a lost runner", () => {
    expect(lostRunner({ log: SPOT_RECLAIM_LOG })).toBe(true);
  });

  it("calls a failure annotation about lost communication a lost runner", () => {
    expect(
      lostRunner({
        log: null,
        annotations: [
          { annotation_level: "failure", message: LOST_COMMUNICATION },
        ],
      }),
    ).toBe(true);
  });

  it("sees past the cancellation line GitHub logs after the shutdown", () => {
    // The tail of job 110879576762 on 2026-10-02.
    const log = [
      "2026-10-02T14:34:34.2148462Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.",
      "2026-10-02T14:34:34.2439614Z ##[error]The operation was canceled.",
      "2026-10-02T14:34:34.3000000Z Cleaning up orphan processes",
    ].join("\n");
    expect(lostRunner({ log })).toBe(true);
  });

  it("does not call a job that was only cancelled a lost runner", () => {
    const log = "2026-10-02T14:34:34.2439614Z ##[error]The operation was canceled.";
    expect(lastErrorLine(log)).toBeNull();
    expect(lostRunner({ log })).toBe(false);
  });

  it("does not call a job that failed on its own a lost runner", () => {
    expect(lostRunner({ log: OWN_FAILURE_LOG })).toBe(false);
  });

  it("does not trust the phrase when a later error ended the job", () => {
    // A test can print the loss message and then fail for its own reasons.
    const log = [
      "2026-10-02T16:12:00.0000000Z ##[error]The runner has received a shutdown signal (printed by a test)",
      OWN_FAILURE_LOG,
    ].join("\n");
    expect(lostRunner({ log })).toBe(false);
  });

  it("ignores a warning annotation that quotes the message", () => {
    expect(
      lostRunner({
        log: OWN_FAILURE_LOG,
        annotations: [
          { annotation_level: "warning", message: LOST_COMMUNICATION },
        ],
      }),
    ).toBe(false);
  });

  it("treats a missing log with no annotation as not lost", () => {
    expect(lostRunner({ log: null, annotations: [] })).toBe(false);
  });
});

describe("decide", () => {
  it("reruns the one lost job on the branch head", () => {
    expect(decide({ run: run(), branchHead: SHA, lost: [checks] })).toEqual({
      action: "job",
      jobId: checks.id,
      reason: "checks lost its runner",
    });
  });

  it("reruns the failed jobs when several lost their runners", () => {
    const lost = [checks, { id: 2, name: "unit (app)" }];
    expect(decide({ run: run(), branchHead: SHA, lost }).action).toBe(
      "failed-jobs",
    );
  });

  it("leaves a run where no job lost its runner", () => {
    expect(decide({ run: run(), branchHead: SHA, lost: [] }).action).toBe(
      "none",
    );
  });

  it("leaves a run that did not fail", () => {
    for (const conclusion of ["success", "cancelled", "timed_out"]) {
      expect(
        decide({ run: run({ conclusion }), branchHead: SHA, lost: [checks] })
          .action,
      ).toBe("none");
    }
  });

  it("stops once the run has used its reruns", () => {
    expect(
      decide({
        run: run({ run_attempt: MAX_RUN_ATTEMPT - 1 }),
        branchHead: SHA,
        lost: [checks],
      }).action,
    ).toBe("job");
    expect(
      decide({
        run: run({ run_attempt: MAX_RUN_ATTEMPT }),
        branchHead: SHA,
        lost: [checks],
      }).action,
    ).toBe("none");
  });

  it("leaves a pull request run whose branch has moved on or is gone", () => {
    const pr = run({ event: "pull_request", head_branch: "fix/thing" });
    expect(
      decide({ run: pr, branchHead: "7c5242fd30", lost: [checks] }).action,
    ).toBe("none");
    expect(decide({ run: pr, branchHead: null, lost: [checks] }).action).toBe(
      "none",
    );
  });

  it("reruns a main run after main has moved on (#5180)", () => {
    // checks queued for 42 minutes, so main was 5 commits ahead when it died.
    expect(
      decide({ run: run(), branchHead: "7c5242fd30", lost: [checks] }).action,
    ).toBe("job");
  });

  it("treats only pushes to the default branch as main", () => {
    expect(
      decide({
        run: run({ head_branch: "release" }),
        branchHead: "7c5242fd30",
        lost: [checks],
      }).action,
    ).toBe("none");
    expect(
      decide({
        run: run({ head_branch: "trunk" }),
        branchHead: "7c5242fd30",
        defaultBranch: "trunk",
        lost: [checks],
      }).action,
    ).toBe("job");
  });
});
