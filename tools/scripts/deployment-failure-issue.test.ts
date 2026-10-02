/**
 * The decisions deployment-failure-issue.mjs makes before it touches GitHub:
 * which runs count as red, which count as a failed ship, and which prove
 * nothing. The superseded run that concludes `success` having run only
 * preflight is the case most worth pinning down, because closing an incident
 * on it would record a recovery that never happened.
 */
import { describe, expect, it } from "vitest";
import {
  bodyFor,
  classifyRun,
  deployedCleanly,
  isDeployJob,
  prNumberFrom,
  recoveredBody,
  titleFor,
} from "./deployment-failure-issue.mjs";

const job = (
  name: string,
  conclusion: string | null,
  extra: Record<string, unknown> = {},
) => ({
  name,
  conclusion,
  html_url: `https://github.com/x/y/actions/runs/1/job/${name.length}`,
  steps: [],
  ...extra,
});
const run = (conclusion: string, extra: Record<string, unknown> = {}) => ({
  id: 1,
  conclusion,
  head_sha: "34773d74354bcb14c89da0f55b655ae7924a34d4",
  html_url: "https://github.com/x/y/actions/runs/1",
  created_at: "2026-09-23T22:52:04Z",
  head_commit: { message: "fix(app): a thing (#3946)\n\nbody" },
  ...extra,
});

describe("isDeployJob", () => {
  it("names every job that writes to production", () => {
    expect(isDeployJob("deploy oxagen.sh")).toBe(true);
    expect(isDeployJob("deploy app.oxagen.sh")).toBe(true);
    expect(isDeployJob("Production schema is ready for this commit")).toBe(
      true,
    );
    expect(isDeployJob("Manual production app deployment")).toBe(true);
  });

  it("does not count checks, tests or staging", () => {
    expect(isDeployJob("checks")).toBe(false);
    expect(isDeployJob("e2e")).toBe(false);
    expect(isDeployJob("Verify this commit in staging / smoke")).toBe(false);
  });
});

describe("classifyRun", () => {
  it("calls a failed check main-red", () => {
    expect(
      classifyRun(run("failure"), [
        job("checks", "failure"),
        job("test", "success"),
      ]),
    ).toBe("main-red");
  });

  it("calls a failed deploy or migration a deploy failure, even beside a failed check", () => {
    expect(
      classifyRun(run("failure"), [
        job("checks", "success"),
        job("deploy api.oxagen.sh", "failure"),
      ]),
    ).toBe("deploy");
    expect(
      classifyRun(run("failure"), [
        job("Production schema is ready for this commit", "timed_out"),
      ]),
    ).toBe("deploy");
  });

  it("calls a workflow that never started main-red", () => {
    expect(classifyRun(run("startup_failure"), [])).toBe("main-red");
  });

  it("calls a run green only when checks and test both ran and passed", () => {
    expect(
      classifyRun(run("success"), [
        job("checks", "success"),
        job("test", "success"),
      ]),
    ).toBe("green");
  });

  it("does not call a superseded run green", () => {
    // Preflight found a newer commit, so every expensive job skipped and the
    // run still concludes success. It verified nothing.
    const jobs = [
      job("Preflight (skip the gate for a superseded commit)", "success"),
      job("checks", "skipped"),
      job("test", "skipped"),
    ];
    expect(classifyRun(run("success"), jobs)).toBe("none");
  });

  it("says nothing about a cancelled run", () => {
    expect(classifyRun(run("cancelled"), [job("checks", "cancelled")])).toBe(
      "none",
    );
  });
});

describe("deployedCleanly", () => {
  it("needs a deploy job that succeeded and none that failed", () => {
    expect(deployedCleanly([job("deploy app.oxagen.sh", "success")])).toBe(
      true,
    );
    expect(
      deployedCleanly([
        job("deploy app.oxagen.sh", "success"),
        job("deploy api.oxagen.sh", "failure"),
      ]),
    ).toBe(false);
    expect(deployedCleanly([job("deploy app.oxagen.sh", "skipped")])).toBe(
      false,
    );
    expect(deployedCleanly([job("checks", "success")])).toBe(false);
  });
});

describe("prNumberFrom", () => {
  it("reads the PR from a squash-merge subject", () => {
    expect(prNumberFrom("fix(app): a thing (#3946)\n\nbody (#12)")).toBe(3946);
  });

  it("returns null when the subject names none", () => {
    expect(prNumberFrom("Merge branch main")).toBeNull();
    expect(prNumberFrom(undefined)).toBeNull();
  });
});

describe("titleFor", () => {
  it("follows the repo title standard with a P0 prefix", () => {
    expect(titleFor("main-red", [job("checks", "failure")])).toBe(
      "P0 T3 S DevOps (CI): Main is red: checks",
    );
    expect(titleFor("deploy", [job("deploy api.oxagen.sh", "failure")])).toBe(
      "P0 T3 S DevOps (Deploy): Production deploy failed on main: deploy api.oxagen.sh",
    );
  });

  it("names at most three jobs", () => {
    const jobs = ["a", "b", "c", "d", "e"].map((n) => job(n, "failure"));
    expect(titleFor("main-red", jobs)).toBe(
      "P0 T3 S DevOps (CI): Main is red: a, b, c, +2 more",
    );
  });

  it("says the pipeline failed when no job is named", () => {
    expect(titleFor("main-red", [])).toBe(
      "P0 T3 S DevOps (CI): Main is red: the pipeline failed",
    );
  });

  // CLAUDE.md under Issue titles, and the regex /triage-issues checks.
  it("matches the title format the triage pass reads back", () => {
    const format =
      /^P[0-4] T[1-4] (XS|S|M|L|XL) (Bug|Feature|Improvement|Chore|Documentation|DevOps) \([A-Za-z ]+\): /;
    expect(titleFor("main-red", [job("checks", "failure")])).toMatch(format);
    expect(titleFor("deploy", [job("deploy app", "failure")])).toMatch(format);
  });
});

describe("bodyFor and recoveredBody", () => {
  it("names the commit, PR, run and failing step", () => {
    const body = bodyFor("main-red", run("failure"), [
      job("checks", "failure", {
        steps: [{ name: "Lint and typecheck", conclusion: "failure" }],
      }),
    ]);
    expect(body).toContain("<!-- deployment-failure:kind=main-red -->");
    expect(body).toContain("`34773d7` fix(app): a thing (#3946) (from #3946)");
    expect(body).toContain('at step "Lint and typecheck"');
    expect(body).toContain("https://github.com/x/y/actions/runs/1");
  });

  it("marks a job that lost its runner and says a rerun is coming (#5180)", () => {
    // The step that was running reads success when AWS reclaims the runner.
    const lostJob = job("checks", "failure", {
      id: 110905320352,
      steps: [{ name: "Lint and typecheck", conclusion: "success" }],
    });
    const realJob = job("unit (app)", "failure", {
      id: 7,
      steps: [{ name: "Unit tests", conclusion: "failure" }],
    });
    const body = bodyFor(
      "main-red",
      run("failure"),
      [lostJob, realJob],
      new Set([110905320352]),
    );
    expect(body).toContain("failure: its runner shut down mid-job");
    expect(body).toContain('unit (app)](https://github.com/x/y/actions/runs/1/job/10) failure at step "Unit tests"');
    expect(body).toContain("`rerun-lost-runner.yml` reruns them");
  });

  it("adds no rerun note when no job lost its runner", () => {
    const body = bodyFor("main-red", run("failure"), [
      job("checks", "failure", { id: 1 }),
    ]);
    expect(body).not.toContain("shut down mid-job");
    expect(body).not.toContain("rerun-lost-runner");
  });

  it("ticks only the DoD box CI owns, so dod-close-guard accepts the close", () => {
    const body = bodyFor("deploy", run("failure"), [
      job("deploy app.oxagen.sh", "failure"),
    ]);
    expect(body).toContain("- [ ] A later run on `main` deploys cleanly");
    const done = recoveredBody(body);
    expect(done).toContain("- [x] A later run on `main` deploys cleanly");
    expect(done).not.toContain("- [ ]");
  });
});
