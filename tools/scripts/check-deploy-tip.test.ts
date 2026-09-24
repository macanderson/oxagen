/**
 * The deploy order, replayed. #2874: `9fa5382` (committed 18:36) had its
 * deployment created at 19:18, after its descendant `ebcbcb8` (18:46) had
 * shipped at 18:48; the older run must skip. 2026-09-24: e111db5 went green
 * and three merges landed during its staging jobs; it must still ship,
 * because nothing newer was live. The shape guard is asserted on the real
 * pipeline and on mutations of it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_ENVIRONMENT,
  DEPLOY_JOBS,
  decide,
  deployJobSteps,
  guardProblems,
  readLive,
  readMainTip,
  readOrder,
  readRelation,
  recordDeploy,
  SHIP_GATE,
  taskFor,
} from "./check-deploy-tip.mjs";

const OLDER = "9fa5382000000000000000000000000000000000";
const NEWER = "ebcbcb8000000000000000000000000000000000";
const NEWEST = "d6af24f000000000000000000000000000000000";

type Call = { url: string; init?: RequestInit };

/** A fetch that answers by URL substring and records every call. */
function fakeFetch(routes: Record<string, unknown>, calls: Call[] = []) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const key = Object.keys(routes).find((k) => href.includes(k));
    if (key === undefined) return { ok: false, status: 404 } as never;
    const value = routes[key];
    if (value instanceof Error) throw value;
    if (typeof value === "number") return { ok: false, status: value } as never;
    return { ok: true, json: async () => value } as never;
  };
}

describe("decide", () => {
  it("skips the older commit's run when a descendant already shipped (#2874)", () => {
    const late = decide({ sha: OLDER, live: NEWER, relation: "behind" });
    expect(late.deploy).toBe(false);
    expect(late.reason).toMatch(/backwards/);
  });

  it("ships a commit main has moved past when it is newer than what is live (2026-09-24)", () => {
    // e111db5 was superseded by three merges during staging; nothing newer
    // than it was live, so it ships.
    expect(
      decide({ sha: NEWER, live: OLDER, relation: "ahead" }),
    ).toMatchObject({ deploy: true });
  });

  it("ships a re-run of the live commit", () => {
    expect(
      decide({ sha: NEWER, live: NEWER, relation: "identical" }).deploy,
    ).toBe(true);
  });

  it("ships the first deploy of a service, with nothing recorded", () => {
    expect(decide({ sha: OLDER, live: null })).toMatchObject({
      deploy: true,
      reason: expect.stringMatching(/nothing is recorded/),
    });
  });

  it("on a diverged history ships only main's tip", () => {
    expect(
      decide({ sha: NEWEST, live: NEWER, relation: "diverged", tip: NEWEST })
        .deploy,
    ).toBe(true);
    expect(
      decide({ sha: OLDER, live: NEWER, relation: "diverged", tip: NEWEST })
        .deploy,
    ).toBe(false);
    const unknown = decide({
      sha: OLDER,
      live: NEWER,
      relation: "diverged",
      tip: null,
    });
    expect(unknown.deploy).toBe(true);
    expect(unknown.warning).toBeDefined();
  });

  it("fails open with a warning when the API could not answer", () => {
    const verdict = decide({ sha: OLDER, live: null, error: "HTTP 503" });
    expect(verdict.deploy).toBe(true);
    expect(verdict.warning).toMatch(/HTTP 503/);
  });

  it("fails open on a compare status it does not know", () => {
    const verdict = decide({
      sha: OLDER,
      live: NEWER,
      relation: "sideways" as never,
    });
    expect(verdict.deploy).toBe(true);
    expect(verdict.warning).toMatch(/sideways/);
  });
});

describe("readLive", () => {
  it("asks for the newest production deployment of the service's task", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ "/deployments?": [{ sha: NEWER }] }, calls);
    await expect(
      readLive({ repository: "o/r", token: "t", service: "app", fetchImpl }),
    ).resolves.toEqual({ live: NEWER });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/repos/o/r/deployments");
    expect(url.searchParams.get("environment")).toBe(DEPLOY_ENVIRONMENT);
    expect(url.searchParams.get("task")).toBe(taskFor("app"));
    expect(url.searchParams.get("per_page")).toBe("1");
  });

  it("answers null when nothing is recorded", async () => {
    const fetchImpl = fakeFetch({ "/deployments?": [] });
    await expect(
      readLive({ repository: "o/r", token: "t", service: "api", fetchImpl }),
    ).resolves.toEqual({ live: null });
  });

  it("never throws: a non-2xx, a network error or a malformed body becomes an error", async () => {
    for (const [answer, error] of [
      [502, "HTTP 502"],
      [new Error("ECONNRESET"), "ECONNRESET"],
      [{ not: "a list" }, "deployments response was not a list"],
    ] as const) {
      const fetchImpl = fakeFetch({ "/deployments?": answer });
      await expect(
        readLive({ repository: "o/r", token: "t", service: "mcp", fetchImpl }),
      ).resolves.toEqual({ live: null, error });
    }
  });

  it("fails open when the API does not answer in time", async () => {
    // A fetch that settles only when its signal aborts, the way a real fetch
    // does against a socket that never replies.
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    const read = await readLive({
      repository: "o/r",
      token: "t",
      service: "app",
      fetchImpl: hang as never,
      timeoutMs: 5,
    });
    expect(read.error).toMatch(/timeout|abort/i);
    expect(decide({ sha: OLDER, ...read }).deploy).toBe(true);
  });
});

describe("readRelation and readMainTip", () => {
  it("reads the compare status for live...sha", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ "/compare/": { status: "ahead" } }, calls);
    await expect(
      readRelation({
        repository: "o/r",
        token: "t",
        base: OLDER,
        head: NEWER,
        fetchImpl,
      }),
    ).resolves.toEqual({ relation: "ahead" });
    expect(calls[0]?.url).toContain(`/repos/o/r/compare/${OLDER}...${NEWER}`);
  });

  it("reads main's head sha, and never throws", async () => {
    await expect(
      readMainTip({
        repository: "o/r",
        token: "t",
        fetchImpl: fakeFetch({ "/branches/main": { commit: { sha: NEWEST } } }),
      }),
    ).resolves.toEqual({ tip: NEWEST });
    await expect(
      readMainTip({
        repository: "o/r",
        token: "t",
        fetchImpl: fakeFetch({ "/branches/main": 500 }),
      }),
    ).resolves.toEqual({ tip: null, error: "HTTP 500" });
  });
});

describe("readOrder", () => {
  const io = { repository: "o/r", token: "t", service: "app" };

  it("reads live, then compares, and reads the tip only on a diverged history", async () => {
    const calls: Call[] = [];
    const ahead = await readOrder({
      ...io,
      sha: NEWER,
      fetchImpl: fakeFetch(
        {
          "/deployments?": [{ sha: OLDER }],
          "/compare/": { status: "ahead" },
        },
        calls,
      ),
    });
    expect(ahead).toEqual({ sha: NEWER, live: OLDER, relation: "ahead" });
    expect(calls.some((c) => c.url.includes("/branches/main"))).toBe(false);

    const diverged = await readOrder({
      ...io,
      sha: NEWEST,
      fetchImpl: fakeFetch({
        "/deployments?": [{ sha: OLDER }],
        "/compare/": { status: "diverged" },
        "/branches/main": { commit: { sha: NEWEST } },
      }),
    });
    expect(decide(diverged).deploy).toBe(true);
  });

  it("skips the compare when nothing is recorded, and carries a compare error to a fail-open deploy", async () => {
    const calls: Call[] = [];
    const first = await readOrder({
      ...io,
      sha: OLDER,
      fetchImpl: fakeFetch({ "/deployments?": [] }, calls),
    });
    expect(first).toEqual({ sha: OLDER, live: null });
    expect(calls).toHaveLength(1);

    const broken = await readOrder({
      ...io,
      sha: OLDER,
      fetchImpl: fakeFetch({
        "/deployments?": [{ sha: NEWER }],
        "/compare/": 502,
      }),
    });
    expect(broken.error).toBe("HTTP 502");
    expect(decide(broken).deploy).toBe(true);
  });
});

describe("recordDeploy", () => {
  it("creates a production deployment for the service's task and marks it successful", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      { "/statuses": { id: 9 }, "/deployments": { id: 42 } },
      calls,
    );
    await expect(
      recordDeploy({
        repository: "o/r",
        token: "t",
        sha: NEWER,
        service: "api",
        runUrl: "https://github.com/o/r/actions/runs/1",
        fetchImpl,
      }),
    ).resolves.toEqual({ id: 42 });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      ref: NEWER,
      task: "deploy:api",
      environment: "production",
      auto_merge: false,
      required_contexts: [],
    });
    expect(calls[1]?.url).toContain("/repos/o/r/deployments/42/statuses");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      state: "success",
      log_url: "https://github.com/o/r/actions/runs/1",
    });
  });

  it("never throws: a refused create or status becomes an error", async () => {
    await expect(
      recordDeploy({
        repository: "o/r",
        token: "t",
        sha: NEWER,
        service: "api",
        fetchImpl: fakeFetch({ "/deployments": 422 }),
      }),
    ).resolves.toEqual({ error: "creating the deployment: HTTP 422" });
    await expect(
      recordDeploy({
        repository: "o/r",
        token: "t",
        sha: NEWER,
        service: "api",
        fetchImpl: fakeFetch({ "/statuses": 500, "/deployments": { id: 7 } }),
      }),
    ).resolves.toEqual({ id: 7, error: "marking it successful: HTTP 500" });
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

  it("finds every deploy job gated after the order step, ending in the record step", () => {
    expect(DEPLOY_JOBS).toContain("publish-installers");
    for (const job of DEPLOY_JOBS) {
      const steps = deployJobSteps(pipeline, job) ?? [];
      const orderAt = steps.findIndex((s) => s.id === "order");
      expect(orderAt).toBe(1);
      expect(steps.length).toBeGreaterThan(3);
      expect(steps.slice(orderAt + 1).every((s) => s.gated)).toBe(true);
      expect(steps.at(-1)?.id).toBe("record");
    }
  });

  it("holds the installer publish to the same rule as the deploys", () => {
    // The installers are a service of their own: an older run reaching here
    // after a newer one must not replace newer installers with older ones.
    const steps = deployJobSteps(pipeline, "publish-installers") ?? [];
    const dispatch = steps.find(
      (s) => s.name === "Dispatch the desktop build for this commit",
    );
    expect(dispatch?.gated).toBe(true);
    expect(pipeline).toContain("      group: production-desktop");
    expect(pipeline).toMatch(/DEPLOY_SERVICE: desktop/);
  });

  it("fails when one step after the order step loses its gate", () => {
    const gate = `        if: ${SHIP_GATE}`;
    const at = pipeline.lastIndexOf(gate);
    const mutated =
      pipeline.slice(0, at) + pipeline.slice(at + gate.length + 1);
    const problems = guardProblems(mutated);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /whether or not a newer commit is already live/,
    );
  });

  it("fails when a deploy job has no order step at all", () => {
    const mutated = pipeline.replace(/^        id: order\n/m, "");
    expect(guardProblems(mutated)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/no step with id "order"/),
      ]),
    );
  });

  it("fails when a deploy job stops recording what shipped", () => {
    const mutated = pipeline.replace(/^        id: record\n/m, "");
    expect(guardProblems(mutated)).toEqual([
      expect.stringMatching(/deploy-web: no step with id "record"/),
    ]);
  });

  it("fails when a deploy job loses its lock or would cancel a deploy in flight", () => {
    const unlocked = pipeline.replace(
      /\n    concurrency:\n      group: production-web\n      cancel-in-progress: false\n/,
      "\n",
    );
    expect(guardProblems(unlocked)).toEqual([
      expect.stringMatching(/deploy-web: missing the per-service lock/),
    ]);
    const cancelling = pipeline.replace(
      /(group: production-\$\{\{ matrix\.service \}\}\n      cancel-in-progress:) false/,
      "$1 true",
    );
    expect(guardProblems(cancelling)).toEqual([
      expect.stringMatching(/deploy-node: missing the per-service lock/),
    ]);
  });
});
