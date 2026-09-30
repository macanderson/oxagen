// The steering repo health jobs (lane S2, #4560). The sweep asks the runner
// for one request per ready steering repo and sends them. The health check
// reads one repo through the runner. The runner is the seam
// `@oxagen/handlers` installs at boot, so these tests install a fake one and
// assert what it receives, which steps run, and what the jobs send.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));

import { NonRetriableError } from "@oxagen/functions";
import {
  setSteeringRepoHealthRunner,
  type SteeringRepoHealthRequest,
  type SteeringRepoHealthRunner,
  type SteeringRepoHealthTrigger,
} from "../lib/steering-repo-health-runner";
import {
  steeringRepoHealthCheck,
  steeringRepoSweep,
} from "./steering-repo.sweep";

const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WORKSPACE_ID = "0192d4a8-7c1e-7a00-8000-0000000c0e01";

const SWEEP_TRIGGER: SteeringRepoHealthTrigger = {
  reason: "sweep",
  actor: null,
  at: null,
  settings: [],
  pull_request: null,
};

/** What the GitHub route sends when someone deletes the merge ruleset. */
const RULESET_DELETED: SteeringRepoHealthTrigger = {
  reason: "repository_ruleset.deleted",
  actor: "dana-ops",
  at: "2026-09-26T21:02:48.000Z",
  settings: ["rulesets.oxagen_merges"],
  pull_request: null,
};

const ORG_REQUEST: SteeringRepoHealthRequest = {
  name: "steering-repo/health.requested",
  data: {
    orgId: ORG_ID,
    workspaceId: null,
    key: `${ORG_ID}:org`,
    trigger: SWEEP_TRIGGER,
  },
};

const WORKSPACE_REQUEST: SteeringRepoHealthRequest = {
  name: "steering-repo/health.requested",
  data: {
    orgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    key: `${ORG_ID}:${WORKSPACE_ID}`,
    trigger: SWEEP_TRIGGER,
  },
};

type FakeStep = {
  names: string[];
  sent: { label: string; events: unknown }[];
  run: (name: string, fn: () => unknown) => Promise<unknown>;
  sendEvent: (label: string, events: unknown) => Promise<void>;
};

type Handler = (ctx: {
  event: { data: Record<string, unknown> };
  step: FakeStep;
}) => Promise<unknown>;

const sweep = steeringRepoSweep as unknown as Handler;
const check = steeringRepoHealthCheck as unknown as Handler;

/**
 * A step that records each name and each send, then runs the body. A name in
 * `memo` returns the stored output without running the body, as Inngest does
 * on a replay.
 */
function fakeStep(memo: ReadonlyMap<string, unknown> = new Map()): FakeStep {
  const names: string[] = [];
  const sent: { label: string; events: unknown }[] = [];
  return {
    names,
    sent,
    run: async (name, fn) => {
      names.push(name);
      return memo.has(name) ? memo.get(name) : fn();
    },
    sendEvent: async (label, events) => {
      names.push(label);
      sent.push({ label, events });
    },
  };
}

/** Install a fresh runner whose calls each test can read. */
function installRunner(
  over: Partial<SteeringRepoHealthRunner> = {},
) {
  const installed = {
    sweepRequests: vi.fn<SteeringRepoHealthRunner["sweepRequests"]>(
      over.sweepRequests ?? (async () => [ORG_REQUEST, WORKSPACE_REQUEST]),
    ),
    check: vi.fn<SteeringRepoHealthRunner["check"]>(
      over.check ?? (async () => ({ health: "healthy" })),
    ),
  };
  setSteeringRepoHealthRunner(installed);
  return installed;
}

/** The error a run rejects with. It fails the test when the run finishes. */
async function failureOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error("The run finished, and the test expected it to fail.");
}

function configOf(id: string) {
  return mocks.configs.find((c) => (c.options as { id: string }).id === id);
}

describe("steering-repo/health-sweep", () => {
  it("runs every 10 minutes, one sweep at a time, with one retry", () => {
    expect(configOf("steering-repo/health-sweep")).toEqual({
      options: {
        id: "steering-repo/health-sweep",
        retries: 1,
        concurrency: { limit: 1 },
      },
      trigger: { cron: "*/10 * * * *" },
    });
  });

  it("sends one health request per ready steering repo in one send", async () => {
    const runner = installRunner();
    const step = fakeStep();
    await expect(sweep({ event: { data: {} }, step })).resolves.toEqual({
      requested: 2,
    });
    expect(runner.sweepRequests).toHaveBeenCalledTimes(1);
    expect(step.names).toEqual([
      "list-steering-repos",
      "request-health-checks",
    ]);
    expect(step.sent).toEqual([
      {
        label: "request-health-checks",
        events: [
          {
            name: "steering-repo/health.requested",
            data: {
              orgId: ORG_ID,
              workspaceId: null,
              key: `${ORG_ID}:org`,
              trigger: SWEEP_TRIGGER,
            },
          },
          {
            name: "steering-repo/health.requested",
            data: {
              orgId: ORG_ID,
              workspaceId: WORKSPACE_ID,
              key: `${ORG_ID}:${WORKSPACE_ID}`,
              trigger: SWEEP_TRIGGER,
            },
          },
        ],
      },
    ]);
    expect(runner.check).not.toHaveBeenCalled();
  });

  it("sends nothing when no steering repo is ready", async () => {
    installRunner({ sweepRequests: async () => [] });
    const step = fakeStep();
    await expect(sweep({ event: { data: {} }, step })).resolves.toEqual({
      requested: 0,
    });
    expect(step.names).toEqual(["list-steering-repos"]);
    expect(step.sent).toEqual([]);
  });

  it("fails without sending when the runner cannot list the steering repos", async () => {
    installRunner({
      sweepRequests: async () => {
        throw new Error("Postgres answered 57P01");
      },
    });
    const step = fakeStep();
    await expect(sweep({ event: { data: {} }, step })).rejects.toThrow(
      "Postgres answered 57P01",
    );
    expect(step.sent).toEqual([]);
  });

  it("reaches the runner only inside step.run, so a replay sends the stored list", async () => {
    const runner = installRunner();
    const step = fakeStep(
      new Map([["list-steering-repos", [WORKSPACE_REQUEST]]]),
    );
    await expect(sweep({ event: { data: {} }, step })).resolves.toEqual({
      requested: 1,
    });
    expect(runner.sweepRequests).not.toHaveBeenCalled();
    expect(step.sent).toEqual([
      {
        label: "request-health-checks",
        events: [
          {
            name: "steering-repo/health.requested",
            data: WORKSPACE_REQUEST.data,
          },
        ],
      },
    ]);
  });
});

describe("steering-repo/health-check", () => {
  it("runs on the health request with three retries and one read per repo at a time", () => {
    expect(configOf("steering-repo/health-check")).toEqual({
      options: {
        id: "steering-repo/health-check",
        retries: 3,
        concurrency: { limit: 1, key: "event.data.key" },
      },
      trigger: { event: "steering-repo/health.requested" },
    });
  });

  it("reads the workspace's steering repo with the event's trigger", async () => {
    const runner = installRunner({
      check: async () => ({ health: "drifted" }),
    });
    const step = fakeStep();
    await expect(
      check({
        event: {
          data: {
            orgId: ORG_ID,
            workspaceId: WORKSPACE_ID,
            key: `${ORG_ID}:${WORKSPACE_ID}`,
            trigger: RULESET_DELETED,
          },
        },
        step,
      }),
    ).resolves.toEqual({ health: "drifted" });
    expect(step.names).toEqual(["check"]);
    expect(runner.check.mock.calls).toEqual([
      [{ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, RULESET_DELETED],
    ]);
    expect(runner.sweepRequests).not.toHaveBeenCalled();
  });

  it("reads an event with no workspace as the organization repository", async () => {
    // The sweep sends workspaceId null for `<org>/oxagen-config`. An event that
    // leaves the field out, or carries a non-string, reads the same way.
    for (const workspaceId of [null, undefined, 42]) {
      const runner = installRunner();
      await check({
        event: {
          data: {
            orgId: ORG_ID,
            ...(workspaceId === undefined ? {} : { workspaceId }),
            key: `${ORG_ID}:org`,
            trigger: SWEEP_TRIGGER,
          },
        },
        step: fakeStep(),
      });
      expect(runner.check.mock.calls).toEqual([
        [{ orgId: ORG_ID, workspaceId: null }, SWEEP_TRIGGER],
      ]);
    }
  });

  it("reads an event with no trigger as the sweep", async () => {
    const runner = installRunner();
    await check({
      event: { data: { orgId: ORG_ID, workspaceId: WORKSPACE_ID } },
      step: fakeStep(),
    });
    expect(runner.check.mock.calls).toEqual([
      [{ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, SWEEP_TRIGGER],
    ]);
  });

  it("returns null health when the scope has no ready steering repo", async () => {
    installRunner({ check: async () => null });
    await expect(
      check({
        event: { data: { orgId: ORG_ID, workspaceId: WORKSPACE_ID } },
        step: fakeStep(),
      }),
    ).resolves.toEqual({ health: null });
  });

  it("stops with a non-retriable error when the event names no organization", async () => {
    // A retry reads the same event, so it would fail the same way.
    for (const orgId of [undefined, "", 7]) {
      const runner = installRunner();
      const step = fakeStep();
      const failure = await failureOf(
        check({
          event: {
            data: {
              ...(orgId === undefined ? {} : { orgId }),
              workspaceId: WORKSPACE_ID,
            },
          },
          step,
        }),
      );
      expect(failure).toBeInstanceOf(NonRetriableError);
      expect(failure).toMatchObject({
        name: "NonRetriableError",
        message: expect.stringContaining("names no organization"),
        isNonRetriable: true,
      });
      expect(step.names).toEqual([]);
      expect(runner.check).not.toHaveBeenCalled();
    }
  });

  it("lets a rate limit throw unchanged so Inngest retries the read", async () => {
    const limited = Object.assign(new Error("GitHub answered 403"), {
      name: "GitHubRateLimitedError",
    });
    installRunner({
      check: async () => {
        throw limited;
      },
    });
    const failure = await failureOf(
      check({
        event: { data: { orgId: ORG_ID, workspaceId: WORKSPACE_ID } },
        step: fakeStep(),
      }),
    );
    expect(failure).toBe(limited);
    expect(failure).not.toBeInstanceOf(NonRetriableError);
  });

  it("reaches the runner only inside step.run, so a replay returns the stored result", async () => {
    const runner = installRunner();
    const step = fakeStep(new Map([["check", { health: "diverged" }]]));
    await expect(
      check({
        event: { data: { orgId: ORG_ID, workspaceId: WORKSPACE_ID } },
        step,
      }),
    ).resolves.toEqual({ health: "diverged" });
    expect(runner.check).not.toHaveBeenCalled();
  });
});

describe("steering repo health jobs in a process without handlers", () => {
  it("fail before any send or read with an error Inngest retries", async () => {
    // A fresh copy of the module graph holds no runner. The fresh copy also
    // loads its own @oxagen/functions, so this test reads the error's name
    // instead of checking its class.
    vi.resetModules();
    const fresh = await import("./steering-repo.sweep");
    const freshSweep = fresh.steeringRepoSweep as unknown as Handler;
    const freshCheck = fresh.steeringRepoHealthCheck as unknown as Handler;

    const sweepStep = fakeStep();
    expect(
      await failureOf(freshSweep({ event: { data: {} }, step: sweepStep })),
    ).toMatchObject({
      name: "Error",
      message: expect.stringContaining("no health runner is installed"),
    });
    expect(sweepStep.sent).toEqual([]);

    const checkStep = fakeStep();
    expect(
      await failureOf(
        freshCheck({
          event: { data: { orgId: ORG_ID, workspaceId: WORKSPACE_ID } },
          step: checkStep,
        }),
      ),
    ).toMatchObject({
      name: "Error",
      message: expect.stringContaining("no health runner is installed"),
    });
  });
});
