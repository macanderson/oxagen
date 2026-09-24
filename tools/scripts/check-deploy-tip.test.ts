/**
 * The ordering case from #2874, replayed: `9fa5382` (committed 18:36) had its
 * deployment created at 19:18, after its descendant `ebcbcb8` (committed
 * 18:46) had deployed at 18:48. With the guard, the older run asks for the tip
 * at 19:18, finds `ebcbcb8` (or newer) there, and skips. Both halves of the
 * shape guard are asserted too: the real pipeline passes, and a pipeline with
 * one ungated step or no tip step fails.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decide,
  deployJobSteps,
  guardProblems,
  readMainTip,
  TIP_GATE,
} from "./check-deploy-tip.mjs";

const OLDER = "9fa5382000000000000000000000000000000000";
const NEWER = "ebcbcb8000000000000000000000000000000000";
const NEWEST = "d6af24f000000000000000000000000000000000";

describe("decide", () => {
  it("skips the older commit's run when a descendant already deployed (#2874)", () => {
    // 18:48 — the newer commit's run deploys; it is the tip.
    expect(decide({ sha: NEWER, tip: NEWER })).toMatchObject({ deploy: true });
    // 19:18 — the older commit's run finally reaches its deploy job.
    const late = decide({ sha: OLDER, tip: NEWER });
    expect(late.deploy).toBe(false);
    expect(late.reason).toMatch(/no longer the tip/);
  });

  it("skips even when main has moved past the descendant", () => {
    expect(decide({ sha: OLDER, tip: NEWEST }).deploy).toBe(false);
    expect(decide({ sha: NEWER, tip: NEWEST }).deploy).toBe(false);
  });

  it("deploys the tip", () => {
    expect(decide({ sha: NEWEST, tip: NEWEST })).toMatchObject({
      deploy: true,
    });
  });

  it("fails open with a warning when the API could not answer", () => {
    const verdict = decide({ sha: OLDER, tip: null, error: "HTTP 503" });
    expect(verdict.deploy).toBe(true);
    expect(verdict.warning).toMatch(/HTTP 503/);
  });
});

describe("readMainTip", () => {
  it("returns the head sha of main", async () => {
    const fetchImpl = async () =>
      ({ ok: true, json: async () => ({ commit: { sha: NEWER } }) }) as never;
    await expect(
      readMainTip({ repository: "o/r", token: "t", fetchImpl }),
    ).resolves.toEqual({ tip: NEWER });
  });

  it("passes an abort signal so a hung API call cannot hold the job", async () => {
    let seen: unknown;
    const fetchImpl = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen = init?.signal;
      return {
        ok: true,
        json: async () => ({ commit: { sha: NEWER } }),
      } as never;
    };
    await readMainTip({ repository: "o/r", token: "t", fetchImpl });
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("fails open when the API does not answer in time", async () => {
    // A fetch that only ever settles when its signal aborts, the way a real
    // fetch does against a socket that never replies.
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    const verdict = await readMainTip({
      repository: "o/r",
      token: "t",
      fetchImpl: hang as never,
      timeoutMs: 5,
    });
    expect(verdict.tip).toBeNull();
    expect(verdict.error).toMatch(/timeout|abort/i);
    expect(decide({ sha: OLDER, ...verdict }).deploy).toBe(true);
  });

  it("never throws: a non-2xx or a network error becomes tip: null", async () => {
    const rejected = async () => ({ ok: false, status: 502 }) as never;
    await expect(
      readMainTip({ repository: "o/r", token: "t", fetchImpl: rejected }),
    ).resolves.toEqual({ tip: null, error: "HTTP 502" });
    const thrown = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(
      readMainTip({ repository: "o/r", token: "t", fetchImpl: thrown }),
    ).resolves.toEqual({ tip: null, error: "ECONNRESET" });
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

  it("reads every step of both deploy jobs and finds them gated after the tip step", () => {
    for (const job of ["deploy-web", "deploy-node"]) {
      const steps = deployJobSteps(pipeline, job) ?? [];
      const tipAt = steps.findIndex((s) => s.id === "tip");
      expect(tipAt).toBe(1);
      expect(steps.length).toBeGreaterThan(3);
      expect(steps.slice(tipAt + 1).every((s) => s.gated)).toBe(true);
    }
  });

  it("holds the installer publish to the same rule as the deploys", () => {
    const steps = deployJobSteps(pipeline, "publish-installers") ?? [];
    expect(steps.findIndex((s) => s.id === "tip")).toBe(1);
    expect(steps.at(-1)?.name).toBe(
      "Dispatch the desktop build for this commit",
    );
    expect(steps.at(-1)?.gated).toBe(true);
  });

  it("fails when one step after the tip step loses its gate", () => {
    const gate = `        if: ${TIP_GATE}`;
    const at = pipeline.lastIndexOf(gate);
    const mutated =
      pipeline.slice(0, at) + pipeline.slice(at + gate.length + 1);
    const problems = guardProblems(mutated);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /runs whether or not this commit is still the tip/,
    );
  });

  it("fails when a deploy job has no tip step at all", () => {
    const mutated = pipeline.replace(/^        id: tip\n/m, "");
    expect(guardProblems(mutated)).toEqual(
      expect.arrayContaining([expect.stringMatching(/no step with id "tip"/)]),
    );
  });
});
