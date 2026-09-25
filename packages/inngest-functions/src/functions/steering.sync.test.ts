// The durable repository sync (ADR-182): one sync per requested workspace,
// a second forced one after a merge's grace window, and the five-minute sweep
// that catches a webhook delivery that never arrived. The runner is the seam
// `@oxagen/handlers` installs at boot, so these tests install a fake one and
// assert what the functions hand it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  // What the sweep's three sources answer: main binding heads on the shared
  // plane, legacy wizard connections, and dedicated-plane workspaces.
  heads: [] as { orgId: string; workspaceId: string }[],
  legacy: [] as { orgId: string; workspaceId: string }[],
  dedicated: [] as { orgId: string; workspaceId: string }[],
  where: [] as unknown[],
  configs: [] as { options: unknown; trigger: unknown }[],
}));
vi.mock("@oxagen/database", async (original) => {
  const real = await original<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        selectDistinct: () => ({
          from: () => ({
            where: (where: unknown) => {
              mocks.where.push(where);
              // In call order: the binding heads, then the legacy
              // connections.
              return Promise.resolve(
                mocks.where.length === 1 ? mocks.heads : mocks.legacy,
              );
            },
          }),
        }),
      }),
  };
});
vi.mock("../lib/assistant-run-abandon", () => ({
  listDedicatedPlaneScopes: async () => mocks.dedicated,
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));
import {
  setSteeringSyncRunner,
  type SteeringSyncResult,
} from "../lib/steering-sync-runner";
import { steeringSync, steeringSyncSweep } from "./steering.sync";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

type Step = {
  run: (id: string, fn: () => unknown) => unknown;
  sleep: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
};

function fakeStep(): Step & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    run: async (id, fn) => {
      runs.push(id);
      return fn();
    },
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

const runSync = (data: Record<string, unknown>, step: Step) =>
  (
    steeringSync as unknown as (ctx: {
      event: { data: Record<string, unknown> };
      step: Step;
    }) => Promise<SteeringSyncResult>
  )({ event: { data }, step });

const runSweep = (step: Step) =>
  (steeringSyncSweep as unknown as (ctx: { step: Step }) => Promise<unknown>)({
    step,
  });

const result = (
  over: Partial<SteeringSyncResult> = {},
): SteeringSyncResult => ({
  outcome: "synced",
  headSha: "abc1234",
  retryAfterSeconds: null,
  ...over,
});

const runner = vi.fn();

beforeEach(() => {
  mocks.heads.length = 0;
  mocks.legacy.length = 0;
  mocks.dedicated.length = 0;
  mocks.where.length = 0;
  runner.mockReset();
  runner.mockResolvedValue(result());
  setSteeringSyncRunner(runner);
});

describe("steering/sync", () => {
  it("runs the sync once for the event's workspace", async () => {
    const step = fakeStep();
    const out = await runSync({ ...SCOPE, reason: "push", force: true }, step);
    expect(runner).toHaveBeenCalledTimes(1);
    // Only the scope reaches the runner: the reason is for the event log.
    expect(runner).toHaveBeenCalledWith(SCOPE, { force: true });
    expect(step.sleep).not.toHaveBeenCalled();
    expect(out).toEqual(result());
  });

  it("does not force a sync the event did not ask to force", async () => {
    // Without force, a sync whose branch head has not moved reads nothing
    // more. Only a literal true forces it.
    const step = fakeStep();
    await runSync({ ...SCOPE, reason: "sweep" }, step);
    await runSync({ ...SCOPE, reason: "push", force: "true" }, step);
    expect(runner.mock.calls).toEqual([
      [SCOPE, { force: false }],
      [SCOPE, { force: false }],
    ]);
  });

  it("waits out a merge's grace window, then syncs again with force", async () => {
    // A Context PR merged from Oxagen publishes itself with its reviewer on
    // the ledger. The first sync defers it; the second, after the window,
    // publishes whatever that merge left unpublished.
    runner
      .mockResolvedValueOnce(
        result({ outcome: "current", retryAfterSeconds: 90 }),
      )
      .mockResolvedValueOnce(result({ outcome: "synced" }));
    const step = fakeStep();
    const out = await runSync({ ...SCOPE, reason: "push" }, step);
    expect(step.sleep).toHaveBeenCalledTimes(1);
    expect(step.sleep).toHaveBeenCalledWith("merge-grace", "90s");
    expect(runner.mock.calls).toEqual([
      [SCOPE, { force: false }],
      [SCOPE, { force: true }],
    ]);
    // Two named steps, so a replay after the sleep does not run the first
    // sync again.
    expect(step.runs).toEqual(["sync", "sync-after-grace"]);
    expect(out.outcome).toBe("synced");
  });

  it("lets a failed sync throw, so the function retries it", async () => {
    runner.mockRejectedValue(new Error("GitHub answered 502"));
    await expect(
      runSync({ ...SCOPE, reason: "push" }, fakeStep()),
    ).rejects.toThrow("GitHub answered 502");
  });

  // A refusal reads the same on every retry. Inngest recognises only an
  // error named NonRetriableError inside a step, so the runner's flag has to
  // become one there, or the step is retried to exhaustion first.
  it("turns a refusal the runner flagged into a non-retriable error inside the step", async () => {
    runner.mockRejectedValue(
      Object.assign(new Error("main is gone"), { isNonRetriable: true }),
    );
    await expect(
      runSync({ ...SCOPE, reason: "push" }, fakeStep()),
    ).rejects.toMatchObject({
      name: "NonRetriableError",
      message: "main is gone",
    });
  });

  it("runs one sync at a time per workspace and folds a burst of deliveries into one", () => {
    // A squash merge sends a push and a pull_request event for one change.
    // Keyed on the workspace, they debounce into one sync, and two syncs of
    // one workspace never write the registry at once.
    const config = mocks.configs.find(
      (c) => (c.options as { id: string }).id === "steering/sync",
    );
    expect(config?.trigger).toEqual({ event: "steering/sync.requested" });
    expect(config?.options).toMatchObject({
      concurrency: { limit: 1, key: "event.data.workspaceId" },
      debounce: { key: "event.data.workspaceId" },
    });
  });
});

describe("steering/sync-sweep", () => {
  it("requests one sync per workspace with a main repository, in one send", async () => {
    const other = {
      orgId: SCOPE.orgId,
      workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e02",
    };
    mocks.heads.push(SCOPE, other);
    const step = fakeStep();
    await expect(runSweep(step)).resolves.toEqual({ requested: 2 });
    expect(step.sendEvent).toHaveBeenCalledTimes(1);
    expect(step.sendEvent).toHaveBeenCalledWith("request-syncs", [
      {
        name: "steering/sync.requested",
        data: { ...SCOPE, reason: "sweep" },
      },
      {
        name: "steering/sync.requested",
        data: { ...other, reason: "sweep" },
      },
    ]);
    // The sweep asks; it never syncs in its own run.
    expect(runner).not.toHaveBeenCalled();
  });

  it("reads only main binding heads", async () => {
    // A linked repository does not steer. Sweeping it would cost a sync per
    // linked head every five minutes for nothing.
    await runSweep(fakeStep());
    const query = new PgDialect().sqlToQuery(
      mocks.where[0] as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(query.sql).toContain('"role" = $1');
    expect(query.params).toEqual(["main"]);
  });

  it("sends nothing when no workspace has a main repository", async () => {
    const step = fakeStep();
    await expect(runSweep(step)).resolves.toEqual({ requested: 0 });
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  // Every customer, not only those whose binding lives on the shared plane:
  // a workspace the legacy sources wizard connected has no binding head, and
  // an organization on a dedicated Postgres plane keeps its heads there.
  it("also asks legacy-connected and dedicated-plane workspaces, once each", async () => {
    const legacy = {
      orgId: SCOPE.orgId,
      workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e03",
    };
    const dedicated = {
      orgId: "0192d4a8-7c1e-7a00-8000-00000000d0d0",
      workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e04",
    };
    mocks.heads.push(SCOPE);
    mocks.legacy.push(legacy, SCOPE);
    mocks.dedicated.push(dedicated);
    const step = fakeStep();
    await expect(runSweep(step)).resolves.toEqual({ requested: 3 });
    const sent = (step.sendEvent as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as {
      data: { workspaceId: string };
    }[];
    expect(sent.map((e) => e.data.workspaceId).sort()).toEqual(
      [SCOPE.workspaceId, legacy.workspaceId, dedicated.workspaceId].sort(),
    );
  });

  it("reads legacy connections only for workspaces with no main head", async () => {
    await runSweep(fakeStep());
    const query = new PgDialect().sqlToQuery(
      mocks.where[1] as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(query.sql).toContain("not exists");
    expect(query.sql).toContain("'main'");
  });
});

describe("the runner seam", () => {
  it("refuses to run in a process that installed no runner", async () => {
    // A worker that booted without `@oxagen/handlers/register` must fail
    // loudly on the first sync, not report one that never happened.
    vi.resetModules();
    const fresh = await import("../lib/steering-sync-runner");
    expect(() => fresh.steeringSyncRunner()).toThrow(
      /no sync runner is installed/,
    );
    const installed = vi.fn();
    fresh.setSteeringSyncRunner(installed);
    expect(fresh.steeringSyncRunner()).toBe(installed);
  });
});
