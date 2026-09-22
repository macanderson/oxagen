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
  readCompare,
} from "./check-main-preflight.mjs";

const OLDER = "9fa5382000000000000000000000000000000000";
const NEWER = "ebcbcb8000000000000000000000000000000000";
const ON_MAIN = { eventName: "push", ref: "refs/heads/main" };

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

  it("skips the full gate when a later push to main descends from this commit", () => {
    const verdict = decidePreflight({
      ...ON_MAIN,
      sha: OLDER,
      tip: NEWER,
      compare: { status: "ahead" },
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toMatch(/no longer the tip/);
    expect(verdict.reason).toMatch(/descends from it/);
  });

  it("runs the full gate when the tip is another commit and nothing says it descends from this one", () => {
    // The stale-tip case: main moved, and the compare call gave no answer.
    // Skipping here would trust a tip whose relationship to this commit is
    // unknown, so the gate runs and the warning names the missing answer.
    const verdict = decidePreflight({
      ...ON_MAIN,
      sha: OLDER,
      tip: NEWER,
      compare: { status: null, error: "HTTP 502" },
    });
    expect(verdict.proceed).toBe(true);
    expect(verdict.warning).toMatch(/could not compare/);
    expect(verdict.warning).toMatch(/HTTP 502/);
    expect(
      decidePreflight({ ...ON_MAIN, sha: OLDER, tip: NEWER }).proceed,
    ).toBe(true);
  });

  it.each(["behind", "diverged", "identical"])(
    "runs the full gate when compare says the tip is %s",
    (status) => {
      // A reset or a force-push: the tip's run does not check this commit.
      const verdict = decidePreflight({
        ...ON_MAIN,
        sha: OLDER,
        tip: NEWER,
        compare: { status },
      });
      expect(verdict.proceed).toBe(true);
      expect(verdict.warning).toBeUndefined();
      expect(verdict.reason).toMatch(new RegExp(`compare says ${status}`));
    },
  );

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

describe("readCompare", () => {
  it("returns the compare status between the commit and the tip", async () => {
    let url = "";
    const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => ({ status: "ahead" }) } as never;
    };
    await expect(
      readCompare({
        repository: "o/r",
        token: "t",
        sha: OLDER,
        tip: NEWER,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "ahead" });
    expect(url).toBe(
      `https://api.github.com/repos/o/r/compare/${OLDER}...${NEWER}`,
    );
  });

  it("never throws: a non-2xx, an empty body or a timeout becomes status: null", async () => {
    const rejected = async () => ({ ok: false, status: 404 }) as never;
    await expect(
      readCompare({
        repository: "o/r",
        token: "t",
        sha: OLDER,
        tip: NEWER,
        fetchImpl: rejected,
      }),
    ).resolves.toEqual({ status: null, error: "HTTP 404" });
    const empty = async () => ({ ok: true, json: async () => ({}) }) as never;
    await expect(
      readCompare({
        repository: "o/r",
        token: "t",
        sha: OLDER,
        tip: NEWER,
        fetchImpl: empty,
      }),
    ).resolves.toMatchObject({ status: null });
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    const timedOut = await readCompare({
      repository: "o/r",
      token: "t",
      sha: OLDER,
      tip: NEWER,
      fetchImpl: hang as never,
      timeoutMs: 5,
    });
    expect(timedOut.status).toBeNull();
    expect(timedOut.error).toMatch(/timeout|abort/i);
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
