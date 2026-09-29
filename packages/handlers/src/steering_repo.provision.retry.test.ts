import { HandlerError } from "@oxagen/oxagen";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ role: vi.fn(async () => "Owner") }));

vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));
vi.mock("./logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import {
  createRetrySteeringRepoProvisionHandler,
  type RetrySteeringRepoProvisionDeps,
} from "./steering_repo.provision.retry";
import type {
  SteeringRepoProvisionRequest,
  SteeringRepoScope,
  SteeringRepoState,
} from "./steering_repo.provision";
import { makeCTX, TEST_CTX } from "./test-utils/fixtures";

const NOW = new Date("2026-09-29T00:00:00.000Z");

function failedState(overrides: Partial<SteeringRepoState> = {}): SteeringRepoState {
  return {
    status: "failed",
    step: "create_repository",
    failed_step: "register_webhook",
    error: { code: "step_failed", message: "the hook target could not be reached" },
    provider: "github",
    attempt: 2,
    candidate: "oxagen-acme-2",
    repository: {
      id: 1,
      owner: "acme",
      name: "oxagen-acme-2",
      full_name: "acme/oxagen-acme-2",
      initial_branch: "main",
    },
    commit_sha: "abc123",
    deployment_id: 9,
    binding_id: "rpb_1",
    updated_at: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

type SendImpl = (data: SteeringRepoProvisionRequest, eventId: string) => Promise<void>;

interface Harness {
  deps: RetrySteeringRepoProvisionDeps;
  states: Map<string, SteeringRepoState | null>;
  saves: Array<{ scope: SteeringRepoScope; state: SteeringRepoState }>;
  sends: Array<{ data: SteeringRepoProvisionRequest; eventId: string }>;
  setSendImpl: (fn: SendImpl) => void;
}

function harness(initial: SteeringRepoState | null): Harness {
  const states = new Map<string, SteeringRepoState | null>([["ws_1", initial]]);
  const saves: Harness["saves"] = [];
  const sends: Harness["sends"] = [];
  let sendImpl: SendImpl = async () => {};
  const deps: RetrySteeringRepoProvisionDeps = {
    loadState: async (scope) => {
      const key = scope.kind === "workspace" ? scope.workspaceId : scope.orgId;
      return states.get(key) ?? null;
    },
    saveState: async (scope, state) => {
      const key = scope.kind === "workspace" ? scope.workspaceId : scope.orgId;
      states.set(key, state);
      saves.push({ scope, state });
    },
    send: async (data, eventId) => {
      sends.push({ data, eventId });
      await sendImpl(data, eventId);
    },
    now: () => NOW,
  };
  return { deps, states, saves, sends, setSendImpl: (fn) => (sendImpl = fn) };
}

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockImplementation(async () => "Owner");
});

describe("retry_steering_repo_provision handler", () => {
  it("refuses a caller below org Owner or Admin and reads nothing", async () => {
    mocks.role.mockImplementation(async () => {
      throw new HandlerError({
        code: "forbidden",
        reason: "role_required",
        message: "Only an organization owner or admin can retry a steering repo setup.",
      });
    });
    const h = harness(failedState());
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(h.saves).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it("refuses a scope with no steering repo state to retry", async () => {
    const h = harness(null);
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
    ).rejects.toMatchObject({ code: "not_found", reason: "no_steering_repo_state" });
    expect(h.saves).toEqual([]);
  });

  it("is a no-op, answering the current status, when the setup did not fail or block", async () => {
    const h = harness(failedState({ status: "ready" }));
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
    ).resolves.toEqual({ status: "ready" });
    expect(h.saves).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it("is a no-op while a setup is still provisioning", async () => {
    const h = harness(failedState({ status: "provisioning" }));
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
    ).resolves.toEqual({ status: "provisioning" });
    expect(h.sends).toEqual([]);
  });

  it.each(["failed", "blocked"] as const)(
    "retries a %s setup: clears the error, preserves every other field, and sends with a fresh id",
    async (status) => {
      const initial = failedState({ status });
      const h = harness(initial);
      const handler = createRetrySteeringRepoProvisionHandler(h.deps);
      await expect(
        handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
      ).resolves.toEqual({ status: "provisioning" });

      expect(h.saves).toHaveLength(1);
      expect(h.saves[0]?.state).toEqual({
        ...initial,
        status: "provisioning",
        error: null,
        updated_at: NOW.toISOString(),
      });

      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]?.data).toEqual({
        orgId: "org_1",
        workspaceId: "ws_1",
        actorUserId: "u_1",
      });
      // Distinct from #4683/#4751's backfill id, so Inngest's 24h dedup
      // window on that id never eats a retry.
      expect(h.sends[0]?.eventId).toBe(`steering-repo-retry:ws_1:${NOW.getTime()}`);
      expect(h.sends[0]?.eventId).not.toMatch(/^steering-repo-backfill:/);
    },
  );

  it("does not touch the attempt counter the job itself owns", async () => {
    const initial = failedState({ status: "blocked", attempt: 3 });
    const h = harness(initial);
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    await handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX);
    expect(h.saves[0]?.state.attempt).toBe(3);
  });

  it("retries an organization-level setup by orgId, with a null workspaceId", async () => {
    const h = harness(failedState({ status: "blocked" }));
    h.states.set("org_1", failedState({ status: "blocked" }));
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    const orgOnlyCtx = makeCTX({
      workspaceId: "00000000-0000-0000-0000-000000000000",
    });
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), orgOnlyCtx),
    ).resolves.toEqual({ status: "provisioning" });
    expect(h.sends[0]?.data).toEqual({
      orgId: "org_1",
      workspaceId: null,
      actorUserId: "u_1",
    });
    expect(h.sends[0]?.eventId).toBe(`steering-repo-retry:org_1:${NOW.getTime()}`);
  });

  it("records a failed retry when the send fails, and answers failed", async () => {
    const initial = failedState({ status: "failed" });
    const h = harness(initial);
    h.setSendImpl(async () => {
      throw new Error("inngest unavailable");
    });
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
    ).resolves.toEqual({ status: "failed" });

    expect(h.saves).toHaveLength(2);
    expect(h.saves[0]?.state.status).toBe("provisioning");
    expect(h.saves[1]?.state).toMatchObject({
      status: "failed",
      error: { code: "enqueue_failed", message: "inngest unavailable" },
    });
    // Every other field still comes from the original failed state.
    expect(h.saves[1]?.state.repository).toEqual(initial.repository);
    expect(h.saves[1]?.state.candidate).toEqual(initial.candidate);
  });

  it("does not throw when even recording the failed retry fails", async () => {
    const h = harness(failedState({ status: "failed" }));
    h.setSendImpl(async () => {
      throw new Error("inngest unavailable");
    });
    let saveCalls = 0;
    const failingDeps: RetrySteeringRepoProvisionDeps = {
      ...h.deps,
      saveState: async (scope, state) => {
        saveCalls += 1;
        if (saveCalls === 1) return h.deps.saveState(scope, state);
        throw new Error("db unavailable");
      },
    };
    const handler = createRetrySteeringRepoProvisionHandler(failingDeps);
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), TEST_CTX),
    ).resolves.toEqual({ status: "failed" });
  });
});
