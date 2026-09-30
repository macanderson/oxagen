// The durable steering repo provision (lane S1, #4450). The job asks the
// runner for its step list, then runs each step as its own durable step. The
// runner is the seam `@oxagen/handlers` installs at boot, so these tests
// install a fake one and assert what it receives and which steps run. A
// workspace event first reads whether the workspace is archived. That read is
// mocked here, and steering-repo-backfill.test.ts covers its query.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
  archived: vi.fn<
    (scope: { orgId: string; workspaceId: string }) => Promise<boolean>
  >(async () => false),
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));
vi.mock("../lib/steering-repo-backfill", () => ({
  isWorkspaceArchived: mocks.archived,
}));

import { NonRetriableError } from "@oxagen/functions";
import {
  setSteeringRepoProvisionRunner,
  type SteeringRepoProvisionRunner,
  type SteeringRepoProvisionScope,
  type SteeringRepoStepResult,
} from "../lib/steering-repo-provision-runner";
import { steeringRepoProvision } from "./steering-repo.provision";

const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WORKSPACE_ID = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const ACTOR_ID = "0192d4a8-7c1e-7a00-8000-0000000a0001";

// The runner owns the step list. These are the eight names @oxagen/handlers
// lists today, copied here because this package cannot import handlers.
const STEPS = [
  "pick_connection",
  "create_repository",
  "add_to_installation",
  "write_first_commit",
  "apply_settings",
  "register_webhook",
  "publish_version",
  "bind_repository",
] as const;

// The step that reads whether the workspace is archived. It runs before the
// runner's steps, and only for a workspace event.
const CHECK = "check_workspace";

const WORKSPACE_EVENT = {
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  actorUserId: ACTOR_ID,
};

const WORKSPACE_SCOPE: SteeringRepoProvisionScope = {
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  actorUserId: ACTOR_ID,
};

const ORG_SCOPE: SteeringRepoProvisionScope = {
  orgId: ORG_ID,
  workspaceId: null,
  actorUserId: ACTOR_ID,
};

type FakeStep = {
  names: string[];
  run: (name: string, fn: () => unknown) => Promise<unknown>;
};

type Handler = (ctx: {
  event: { data: Record<string, unknown> };
  step: FakeStep;
}) => Promise<{ status: string; reason?: string }>;

const handler = steeringRepoProvision as unknown as Handler;

/**
 * A step that records each name, then runs the body. A name in `memo` returns
 * the stored output without running the body, as Inngest does on a replay.
 */
function fakeStep(memo: ReadonlyMap<string, unknown> = new Map()): FakeStep {
  const names: string[] = [];
  return {
    names,
    run: async (name, fn) => {
      names.push(name);
      return memo.has(name) ? memo.get(name) : fn();
    },
  };
}

/** A finished step. The workspace repository is ready after its last step. */
function outcome(
  step: string,
  over: Partial<SteeringRepoStepResult> = {},
): SteeringRepoStepResult {
  return {
    step,
    status: step === "bind_repository" ? "ready" : "provisioning",
    ran: true,
    ...over,
  };
}

/** Install a fresh runner whose calls each test can read. */
function installRunner(
  runStep: SteeringRepoProvisionRunner["runStep"] = async (_scope, step) =>
    outcome(step),
  steps: readonly string[] = STEPS,
) {
  const installed = {
    steps: vi.fn<SteeringRepoProvisionRunner["steps"]>(async () => steps),
    runStep: vi.fn<SteeringRepoProvisionRunner["runStep"]>(runStep),
  };
  setSteeringRepoProvisionRunner(installed);
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

/** The shape of SteeringProvisionBlockedError in @oxagen/handlers. */
class BlockedError extends Error {
  readonly code: string;
  readonly isNonRetriable = true;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SteeringProvisionBlockedError";
    this.code = code;
  }
}

beforeEach(() => {
  mocks.archived.mockReset();
  mocks.archived.mockResolvedValue(false);
});

describe("steering-repo/provision", () => {
  it("runs on the provision request with four retries and one run per organization at a time", () => {
    const config = mocks.configs.find(
      (c) => (c.options as { id: string }).id === "steering-repo/provision",
    );
    expect(config).toEqual({
      options: {
        id: "steering-repo/provision",
        retries: 4,
        concurrency: { limit: 1, key: "event.data.orgId" },
      },
      trigger: { event: "steering-repo/provision.requested" },
    });
  });

  it("runs every step the runner lists in order, each as its own durable step", async () => {
    const runner = installRunner();
    const step = fakeStep();
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    ).resolves.toEqual({ status: "ready" });
    expect(step.names).toEqual([CHECK, ...STEPS]);
    expect(runner.steps).toHaveBeenCalledTimes(1);
    expect(mocks.archived.mock.calls).toEqual([
      [{ orgId: ORG_ID, workspaceId: WORKSPACE_ID }],
    ]);
    expect(runner.runStep.mock.calls).toEqual(
      STEPS.map((name) => [WORKSPACE_SCOPE, name]),
    );
  });

  it("ends a queued event for an archived workspace with no provision step", async () => {
    // A person archived the workspace after the backfill sent its event. No
    // step runs, so nothing reaches the provider or the database.
    mocks.archived.mockResolvedValue(true);
    const runner = installRunner();
    const step = fakeStep();
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    ).resolves.toEqual({ status: "skipped", reason: "workspace_archived" });
    expect(step.names).toEqual([CHECK]);
    expect(mocks.archived.mock.calls).toEqual([
      [{ orgId: ORG_ID, workspaceId: WORKSPACE_ID }],
    ]);
    expect(runner.runStep).not.toHaveBeenCalled();
  });

  it("runs no provision step when the archived read fails, and lets Inngest retry it", async () => {
    const outage = new Error("Postgres refused the connection");
    mocks.archived.mockRejectedValue(outage);
    const runner = installRunner();
    const step = fakeStep();
    const failure = await failureOf(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    );
    expect(failure).toBe(outage);
    expect(failure).not.toBeInstanceOf(NonRetriableError);
    expect(step.names).toEqual([CHECK]);
    expect(runner.runStep).not.toHaveBeenCalled();
  });

  it("reads an event with no workspace as the organization repository", async () => {
    // create_organization sends workspaceId null. An event that leaves the
    // field out reads the same way.
    for (const data of [
      { orgId: ORG_ID, workspaceId: null, actorUserId: ACTOR_ID },
      { orgId: ORG_ID, actorUserId: ACTOR_ID },
    ]) {
      const runner = installRunner();
      const step = fakeStep();
      await handler({ event: { data }, step });
      // The organization repository has no workspace to archive.
      expect(step.names).toEqual(STEPS);
      expect(runner.runStep).toHaveBeenCalledTimes(STEPS.length);
      for (const [scope] of runner.runStep.mock.calls)
        expect(scope).toStrictEqual(ORG_SCOPE);
    }
    expect(mocks.archived).not.toHaveBeenCalled();
  });

  it("carries on past a step that does not apply and returns the status the last step reports", async () => {
    // A GitLab group has no installation to add to. The organization
    // repository ends at publish_version, so bind_repository does not apply
    // and reports the status publish_version left.
    const runner = installRunner(async (_scope, step) => {
      if (step === "add_to_installation") return outcome(step, { ran: false });
      if (step === "publish_version") return outcome(step, { status: "ready" });
      if (step === "bind_repository")
        return outcome(step, { status: "ready", ran: false });
      return outcome(step);
    });
    const step = fakeStep();
    await expect(
      handler({
        event: { data: { orgId: ORG_ID, workspaceId: null, actorUserId: ACTOR_ID } },
        step,
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(step.names).toEqual(STEPS);
    expect(runner.runStep).toHaveBeenCalledTimes(STEPS.length);
  });

  it("returns provisioning and runs no step when the runner lists no steps", async () => {
    const runner = installRunner(undefined, []);
    const step = fakeStep();
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    ).resolves.toEqual({ status: "provisioning" });
    expect(step.names).toEqual([CHECK]);
    expect(runner.runStep).not.toHaveBeenCalled();
  });

  it("does not stop on a returned blocked status, only on a thrown refusal", async () => {
    // The result type lists blocked as a status, but the function reads only
    // a thrown error. @oxagen/handlers throws whenever a step is blocked.
    const runner = installRunner(async (_scope, step) =>
      outcome(step, step === "create_repository" ? { status: "blocked" } : {}),
    );
    const step = fakeStep();
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    ).resolves.toEqual({ status: "ready" });
    expect(step.names).toEqual([CHECK, ...STEPS]);
    expect(runner.runStep).toHaveBeenCalledTimes(STEPS.length);
  });

  it("stops at a blocked step with a non-retriable error and runs no later step", async () => {
    // A taken name reads the same on every retry.
    const blocked = new BlockedError(
      "repository_name_taken",
      "The name oxagen-acme is taken.",
    );
    const runner = installRunner(async (_scope, step) => {
      if (step === "create_repository") throw blocked;
      return outcome(step);
    });
    const step = fakeStep();
    const failure = await failureOf(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    );
    expect(failure).toBeInstanceOf(NonRetriableError);
    // Inngest checks the name inside a step, and the adapter checks the flag.
    expect(failure).toMatchObject({
      name: "NonRetriableError",
      message: "The name oxagen-acme is taken.",
      isNonRetriable: true,
    });
    expect((failure as NonRetriableError).cause).toBe(blocked);
    expect(step.names).toEqual([CHECK, "pick_connection", "create_repository"]);
    expect(runner.runStep).toHaveBeenCalledTimes(2);
  });

  it("lets a failure without the flag throw unchanged so Inngest retries the step", async () => {
    const outage = new Error("GitHub answered 502");
    const runner = installRunner(async (_scope, step) => {
      if (step === "write_first_commit") throw outage;
      return outcome(step);
    });
    const step = fakeStep();
    const failure = await failureOf(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    );
    expect(failure).toBe(outage);
    expect(failure).not.toBeInstanceOf(NonRetriableError);
    expect(step.names).toEqual([CHECK, ...STEPS.slice(0, 4)]);
    expect(runner.runStep).toHaveBeenCalledTimes(4);
  });

  it("treats only a literal true flag as non-retriable", async () => {
    for (const flag of [false, "true", 1]) {
      const refusal = Object.assign(new Error("installation 42 refused"), {
        isNonRetriable: flag,
      });
      installRunner(async () => {
        throw refusal;
      });
      await expect(
        handler({ event: { data: WORKSPACE_EVENT }, step: fakeStep() }),
      ).rejects.toBe(refusal);
    }
  });

  it("rethrows a thrown null unchanged", async () => {
    installRunner(() => Promise.reject(null));
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step: fakeStep() }),
    ).rejects.toBeNull();
  });

  it("rethrows a thrown string unchanged", async () => {
    installRunner(() => Promise.reject("GitHub answered 502"));
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step: fakeStep() }),
    ).rejects.toBe("GitHub answered 502");
  });

  it("keeps only the string form of a flagged refusal that is not an Error", async () => {
    // Every refusal @oxagen/handlers throws is an Error, so no run reaches
    // this path today. A plain object loses its message field here: String()
    // reads it as "[object Object]".
    const refusal = {
      isNonRetriable: true,
      message: "The name oxagen-acme is taken.",
    };
    installRunner(async () => {
      throw refusal;
    });
    const failure = await failureOf(
      handler({ event: { data: WORKSPACE_EVENT }, step: fakeStep() }),
    );
    expect(failure).toBeInstanceOf(NonRetriableError);
    expect(failure).toMatchObject({
      name: "NonRetriableError",
      message: "[object Object]",
    });
    expect((failure as NonRetriableError).cause).toBe(refusal);
  });

  it("fails before any step when the runner cannot list its steps", async () => {
    const runner = installRunner();
    runner.steps.mockRejectedValue(
      new Error("Cannot load ./steering_repo.provision"),
    );
    const step = fakeStep();
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    ).rejects.toThrow("Cannot load ./steering_repo.provision");
    expect(step.names).toEqual([]);
    expect(mocks.archived).not.toHaveBeenCalled();
    expect(runner.runStep).not.toHaveBeenCalled();
  });

  it("reaches the runner only inside step.run, so a replay skips the steps that finished", async () => {
    // Inngest returns a finished step's stored output on a replay and never
    // runs its body again. A retry starts at the step that failed, and the
    // archived read is not repeated.
    const memo = new Map<string, unknown>([
      [CHECK, false],
      ...STEPS.slice(0, -1).map((name): [string, unknown] => [
        name,
        outcome(name),
      ]),
    ]);
    const runner = installRunner();
    const step = fakeStep(memo);
    await expect(
      handler({ event: { data: WORKSPACE_EVENT }, step }),
    ).resolves.toEqual({ status: "ready" });
    expect(step.names).toEqual([CHECK, ...STEPS]);
    expect(mocks.archived).not.toHaveBeenCalled();
    expect(runner.runStep.mock.calls).toEqual([
      [WORKSPACE_SCOPE, "bind_repository"],
    ]);
  });
});

describe("steering-repo/provision in a process without handlers", () => {
  it("fails before any step with an error Inngest retries", async () => {
    // A fresh copy of the module graph holds no runner. The fresh copy also
    // loads its own @oxagen/functions, so this test reads the error's name
    // instead of checking its class.
    vi.resetModules();
    const fresh = (await import("./steering-repo.provision"))
      .steeringRepoProvision as unknown as Handler;
    const step = fakeStep();
    const failure = await failureOf(
      fresh({ event: { data: WORKSPACE_EVENT }, step }),
    );
    expect(failure).toMatchObject({
      name: "Error",
      message: expect.stringContaining("no provision runner is installed"),
    });
    expect(step.names).toEqual([]);
  });
});
