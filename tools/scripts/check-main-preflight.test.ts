/**
 * The queue-depth case from 2026-09-21, replayed: a burst of merges left 15
 * queued `pipeline.yml` runs behind 2 in progress, each contracted to spend
 * the full ~75-minute gate on `checks` / `test` / `e2e` / `rls-integration` /
 * `rds-compatibility` even though `deploy-web` / `deploy-node` would refuse
 * the resulting commit anyway once it was no longer the tip of main
 * (check-deploy-tip.mjs, #2874). `decidePreflight` is the one call that
 * short-circuits that work; `guardProblems` is the shape check that every
 * gated job still asks it before running.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decidePreflight,
  GATED_JOBS,
  guardProblems,
  PREFLIGHT_GATE,
} from "./check-main-preflight.mjs";

const OLDER = "9fa5382000000000000000000000000000000000";
const NEWER = "ebcbcb8000000000000000000000000000000000";

describe("decidePreflight", () => {
  it("always proceeds for a pull request — the race only exists between pushes to main", () => {
    expect(
      decidePreflight({
        eventName: "pull_request",
        ref: "refs/heads/some-branch",
        sha: OLDER,
        tip: null,
      }),
    ).toMatchObject({ proceed: true });
  });

  it("always proceeds for workflow_dispatch", () => {
    expect(
      decidePreflight({
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        sha: OLDER,
        tip: null,
      }),
    ).toMatchObject({ proceed: true });
  });

  it("skips the full gate for a push already superseded by a later push to main", () => {
    const verdict = decidePreflight({
      eventName: "push",
      ref: "refs/heads/main",
      sha: OLDER,
      tip: NEWER,
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toMatch(/no longer the tip/);
  });

  it("proceeds when the push to main is still the tip", () => {
    expect(
      decidePreflight({
        eventName: "push",
        ref: "refs/heads/main",
        sha: NEWER,
        tip: NEWER,
      }),
    ).toMatchObject({ proceed: true });
  });

  it("fails open with a warning when the API could not answer", () => {
    const verdict = decidePreflight({
      eventName: "push",
      ref: "refs/heads/main",
      sha: OLDER,
      tip: null,
      error: "HTTP 503",
    });
    expect(verdict.proceed).toBe(true);
    expect(verdict.warning).toMatch(/HTTP 503/);
  });
});

const pipeline = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".github",
    "workflows",
    "pipeline.yml",
  ),
  "utf8",
);

describe("guardProblems", () => {
  it("passes the real pipeline", () => {
    expect(guardProblems(pipeline)).toEqual([]);
  });

  it("fails when a gated job loses the preflight gate from its if:", () => {
    const at = pipeline.indexOf(PREFLIGHT_GATE);
    const mutated =
      pipeline.slice(0, at) +
      "true" +
      pipeline.slice(at + PREFLIGHT_GATE.length);
    const problems = guardProblems(mutated);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/does not include/);
  });

  it("fails when a gated job loses its needs: [preflight]", () => {
    const mutated = pipeline.replace(
      "  checks:\n    needs: [preflight]\n",
      "  checks:\n",
    );
    const problems = guardProblems(mutated);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/checks: does not list "needs: \[preflight\]"/),
      ]),
    );
  });

  it("names every job the queue-depth fix must cover", () => {
    expect(GATED_JOBS).toEqual([
      "checks",
      "test",
      "e2e",
      "rls-integration",
      "rds-compatibility",
    ]);
  });
});
