import { HandlerError } from "@oxagen/oxagen";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(async () => "Owner"),
  orgRole: vi.fn(async (_actor: unknown, _required: unknown) => "Owner"),
}));

vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));
vi.mock("@oxagen/iam/org-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/iam/org-role")>()),
  assertOrgRole: mocks.orgRole,
}));
vi.mock("./logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import {
  createRetrySteeringRepoProvisionHandler,
  type RetrySteeringRepoProvisionDeps,
} from "./steering_repo.provision.retry";
import type {
  SteeringConnection,
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
    connection_choices: [],
    requested_name: null,
    requested_connection: null,
    connection: null,
    updated_at: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

/** A workspace setup that stopped before it created a repository. */
function stoppedBeforeRepo(overrides: Partial<SteeringRepoState> = {}): SteeringRepoState {
  return failedState({
    status: "blocked",
    step: "pick_connection",
    failed_step: "create_repository",
    error: { code: "repository_name_taken", message: "acme already has it." },
    attempt: 4,
    candidate: "oxagen-acme-4",
    repository: null,
    commit_sha: null,
    deployment_id: null,
    binding_id: null,
    ...overrides,
  });
}

const ORG_ONLY_CTX = makeCTX({
  workspaceId: "00000000-0000-0000-0000-000000000000",
});

type SendImpl = (data: SteeringRepoProvisionRequest, eventId: string) => Promise<void>;

interface Harness {
  deps: RetrySteeringRepoProvisionDeps;
  states: Map<string, SteeringRepoState | null>;
  saves: Array<{ scope: SteeringRepoScope; state: SteeringRepoState }>;
  sends: Array<{ data: SteeringRepoProvisionRequest; eventId: string }>;
  connections: Array<{ orgId: string; connection: SteeringConnection }>;
  resets: string[];
  setSendImpl: (fn: SendImpl) => void;
}

function harness(initial: SteeringRepoState | null): Harness {
  const states = new Map<string, SteeringRepoState | null>([["ws_1", initial]]);
  const saves: Harness["saves"] = [];
  const sends: Harness["sends"] = [];
  const connections: Harness["connections"] = [];
  const resets: string[] = [];
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
    saveConnection: async (orgId, connection) => {
      connections.push({ orgId, connection });
    },
    resetConnection: async (orgId) => {
      resets.push(orgId);
      return null;
    },
    send: async (data, eventId) => {
      sends.push({ data, eventId });
      await sendImpl(data, eventId);
    },
    now: () => NOW,
  };
  return {
    deps,
    states,
    saves,
    sends,
    connections,
    resets,
    setSendImpl: (fn) => (sendImpl = fn),
  };
}

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockImplementation(async () => "Owner");
  mocks.orgRole.mockReset();
  mocks.orgRole.mockImplementation(async () => "Owner");
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

  it("refuses a call with no principal behind it, and leaves the failed state untouched", async () => {
    const initial = failedState();
    const h = harness(initial);
    const handler = createRetrySteeringRepoProvisionHandler(h.deps);
    const noPrincipalCtx = makeCTX({ userId: null, apiKeyId: null });
    await expect(
      handler(steeringRepoProvisionRetry.input.parse({}), noPrincipalCtx),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    // Refused before the state flip, so a retry that finds no principal
    // never strands the record in "provisioning" with no event ever sent.
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

  describe("with a connection to choose", () => {
    const CHOICES: SteeringConnection[] = [
      { provider: "github", installation_id: 11, account_login: "acme" },
      { provider: "github", installation_id: 12, account_login: "acme-old" },
    ];
    const choosing = () =>
      failedState({
        status: "blocked",
        step: null,
        failed_step: "pick_connection",
        error: { code: "choose_connection", message: "Choose one." },
        provider: null,
        repository: null,
        connection_choices: CHOICES,
      });
    const retry = (h: Harness, input: unknown) =>
      createRetrySteeringRepoProvisionHandler(h.deps)(
        steeringRepoProvisionRetry.input.parse(input),
        TEST_CTX,
      );

    it("stores the picked connection, then re-sends the job", async () => {
      const h = harness(choosing());
      await expect(
        retry(h, { connection: { provider: "github", id: 12 } }),
      ).resolves.toEqual({ status: "provisioning" });
      expect(h.connections).toEqual([
        { orgId: "org_1", connection: CHOICES[1] },
      ]);
      expect(h.states.get("ws_1")).toMatchObject({
        status: "provisioning",
        error: null,
        connection_choices: [],
      });
      expect(h.sends).toHaveLength(1);
    });

    it("clears the stored connection first when asked, then re-sends", async () => {
      const h = harness(
        failedState({
          status: "blocked",
          failed_step: "create_repository",
          error: { code: "repository_create_refused", message: "Due to policy." },
          repository: null,
        }),
      );
      await expect(retry(h, { resetConnection: true })).resolves.toEqual({
        status: "provisioning",
      });
      expect(h.resets).toEqual(["org_1"]);
      expect(h.sends).toHaveLength(1);
    });

    it("lets only an org Owner or Admin clear or pick the organization's connection (#5228)", async () => {
      // A workspace Owner or Admin passes the contract's gate on their own
      // workspace, but the connection is the organization's.
      mocks.orgRole.mockImplementation(async () => {
        throw new HandlerError({
          code: "forbidden",
          reason: "org_role_required",
          message: "Requires one of the org roles Owner, Admin",
        });
      });
      const blocked = harness(
        failedState({
          status: "blocked",
          failed_step: "create_repository",
          error: { code: "repository_create_refused", message: "Due to policy." },
          repository: null,
        }),
      );
      await expect(
        retry(blocked, { resetConnection: true }),
      ).rejects.toMatchObject({ reason: "org_role_required" });
      expect(blocked.resets).toEqual([]);
      expect(blocked.sends).toEqual([]);

      const picking = harness(choosing());
      await expect(
        retry(picking, { connection: { provider: "github", id: 12 } }),
      ).rejects.toMatchObject({ reason: "org_role_required" });
      expect(picking.connections).toEqual([]);
      expect(picking.sends).toEqual([]);
      expect(mocks.orgRole).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org_1", userId: TEST_CTX.userId }),
        { org: ["Owner", "Admin"], namedRolesOnly: true },
      );
    });

    it("changes nothing when the reset is refused because a repo exists there", async () => {
      const h = harness(failedState());
      h.deps.resetConnection = async () => {
        throw new HandlerError({
          code: "conflict",
          reason: "connection_in_use",
          message: "Oxagen already created acme/oxagen-acme-2 in acme.",
        });
      };
      await expect(retry(h, { resetConnection: true })).rejects.toMatchObject({
        reason: "connection_in_use",
      });
      expect(h.saves).toEqual([]);
      expect(h.sends).toEqual([]);
    });

    it("changes nothing when the organization already holds a different connection", async () => {
      const h = harness(choosing());
      h.deps.saveConnection = async () => {
        throw new HandlerError({
          code: "conflict",
          reason: "connection_already_chosen",
          message: "This organization already creates steering repos in acme.",
        });
      };
      await expect(
        retry(h, { connection: { provider: "github", id: 12 } }),
      ).rejects.toMatchObject({ reason: "connection_already_chosen" });
      expect(h.saves).toEqual([]);
      expect(h.sends).toEqual([]);
    });

    it("refuses, for the organization's own setup, a connection the setup did not find, before any reset", async () => {
      const h = harness(null);
      h.states.set("org_1", choosing());
      const handler = createRetrySteeringRepoProvisionHandler(h.deps);
      await expect(
        handler(
          steeringRepoProvisionRetry.input.parse({
            connection: { provider: "github", id: 99 },
            resetConnection: true,
          }),
          ORG_ONLY_CTX,
        ),
      ).rejects.toMatchObject({ code: "conflict", reason: "unknown_connection" });
      expect(h.resets).toEqual([]);
      expect(h.connections).toEqual([]);
      expect(h.saves).toEqual([]);
      expect(h.sends).toEqual([]);
    });

    it("takes, for a workspace, a connection the setup did not record as the workspace's own request", async () => {
      const h = harness(choosing());
      await expect(
        retry(h, { connection: { provider: "gitlab", id: 42 } }),
      ).resolves.toEqual({ status: "provisioning" });
      // The job checks the place. The organization's connection is untouched.
      expect(h.connections).toEqual([]);
      expect(h.states.get("ws_1")).toMatchObject({
        status: "provisioning",
        error: null,
        requested_connection: { provider: "gitlab", id: 42 },
        connection: null,
        connection_choices: [],
      });
      expect(h.sends).toHaveLength(1);
    });
  });

  describe("with a new name or place before the repository exists", () => {
    const retry = (h: Harness, input: unknown, ctx = TEST_CTX) =>
      createRetrySteeringRepoProvisionHandler(h.deps)(
        steeringRepoProvisionRetry.input.parse(input),
        ctx,
      );

    it("takes a new name and starts the name over at its first attempt", async () => {
      const h = harness(stoppedBeforeRepo());
      await expect(retry(h, { name: "acme-steering" })).resolves.toEqual({
        status: "provisioning",
      });
      expect(h.saves).toHaveLength(1);
      expect(h.saves[0]?.state).toMatchObject({
        status: "provisioning",
        error: null,
        requested_name: "acme-steering",
        attempt: 1,
        candidate: null,
        // A name alone leaves the place as it was.
        requested_connection: null,
      });
      expect(h.connections).toEqual([]);
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]?.data).toEqual({
        orgId: "org_1",
        workspaceId: "ws_1",
        actorUserId: "u_1",
      });
    });

    it("takes a new place, drops the place the last run resolved, and stores nothing on the organization", async () => {
      const resolved: SteeringConnection = {
        provider: "github",
        installation_id: 11,
        account_login: "acme",
      };
      const h = harness(
        stoppedBeforeRepo({
          error: { code: "repository_create_refused", message: "Due to policy." },
          requested_connection: { provider: "github", id: 11 },
          connection: resolved,
        }),
      );
      await expect(
        retry(h, { connection: { provider: "gitlab", id: 42 } }),
      ).resolves.toEqual({ status: "provisioning" });
      expect(h.saves[0]?.state).toMatchObject({
        requested_connection: { provider: "gitlab", id: 42 },
        connection: null,
        connection_choices: [],
        // A place alone leaves the name and its count as they were.
        requested_name: null,
        attempt: 4,
      });
      expect(h.connections).toEqual([]);
      expect(h.sends).toHaveLength(1);
    });

    it("takes a name and a place together", async () => {
      const h = harness(stoppedBeforeRepo());
      await retry(h, {
        name: "acme-steering",
        connection: { provider: "gitlab", id: 42 },
      });
      expect(h.saves[0]?.state).toMatchObject({
        requested_name: "acme-steering",
        requested_connection: { provider: "gitlab", id: 42 },
        connection: null,
        attempt: 1,
      });
    });

    it("refuses a new name once the repository exists, and changes nothing", async () => {
      const h = harness(failedState({ status: "blocked" }));
      await expect(retry(h, { name: "acme-steering" })).rejects.toMatchObject({
        code: "conflict",
        reason: "repository_exists",
      });
      await expect(
        retry(h, { connection: { provider: "gitlab", id: 42 } }),
      ).rejects.toMatchObject({ reason: "repository_exists" });
      expect(h.saves).toEqual([]);
      expect(h.sends).toEqual([]);
    });

    it("refuses a new name while the setup is still running, and changes nothing", async () => {
      const h = harness(stoppedBeforeRepo({ status: "provisioning", error: null }));
      await expect(retry(h, { name: "acme-steering" })).rejects.toMatchObject({
        code: "conflict",
        reason: "setup_running",
      });
      expect(h.saves).toEqual([]);
      expect(h.sends).toEqual([]);
    });

    it("refuses a name for the organization's own setup, which is always oxagen-config", async () => {
      const h = harness(null);
      h.states.set("org_1", stoppedBeforeRepo());
      await expect(
        retry(h, { name: "acme-config" }, ORG_ONLY_CTX),
      ).rejects.toMatchObject({ code: "conflict", reason: "organization_repo_fixed" });
      expect(h.saves).toEqual([]);
      expect(h.sends).toEqual([]);
    });
  });
});
