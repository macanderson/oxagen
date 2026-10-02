// steering_repo.provision.migrate.test.ts: provisioning starts the move of a
// workspace's MCP servers into its steering repo once the repo is ready
// (migrate_tools_to_steering, ADR-245, #4948), and a failed start never fails
// the provisioning.
//
// The step runs against in-memory dependencies that hold the state the
// earlier steps recorded. The production start runs the migration's run with
// its run and dependencies replaced by doubles.
import { getPrincipalAttribution, getScope } from "@oxagen/tenancy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  runToolMigration: vi.fn(),
  toolMigrationDeps: vi.fn(() => ({ marker: "migration deps" })),
}));

vi.mock("./logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./mcp-studio/migration-run", () => ({ runToolMigration: mocks.runToolMigration }));
vi.mock("./mcp-studio/migration-deps", () => ({ toolMigrationDeps: mocks.toolMigrationDeps }));

import {
  initialSteeringRepoState,
  runSteeringRepoStep,
  steeringRepoProvisionDeps,
  type ProvisionDeps,
  type SteeringConnection,
  type SteeringRepoScope,
  type SteeringRepoState,
} from "./steering_repo.provision";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const WORKSPACE: Extract<SteeringRepoScope, { kind: "workspace" }> = {
  kind: "workspace",
  orgId: ORG,
  workspaceId: WS,
};
const CONNECTION: SteeringConnection = {
  provider: "github",
  installation_id: 77,
  account_login: "acme",
  account_type: "Organization",
};

/** The state publish_version leaves: every step but bind_repository done. */
function publishedState(): SteeringRepoState {
  return {
    ...initialSteeringRepoState(NOW),
    step: "publish_version",
    provider: "github",
    candidate: "oxagen-support",
    repository: {
      id: 101,
      owner: "acme",
      name: "oxagen-support",
      full_name: "acme/oxagen-support",
      initial_branch: "main",
    },
    commit_sha: "a".repeat(40),
    deployment_id: 1,
  };
}

/** Dependencies for bind_repository, recording each saved state and the call order. */
function harness(overrides: Partial<ProvisionDeps> = {}) {
  let state = publishedState();
  const saved: SteeringRepoState[] = [];
  const order: string[] = [];
  const start = vi.fn(async () => {
    order.push(`migrate after ${saved.at(-1)?.status ?? "nothing"}`);
  });
  const deps: ProvisionDeps = {
    now: () => NOW,
    load: async () => ({
      target: { org_slug: "acme", workspace: { slug: "support", name: "Support" } },
      state: structuredClone(state),
      connection: CONNECTION,
    }),
    saveState: async (_scope, next) => {
      state = structuredClone(next);
      saved.push(state);
    },
    saveConnection: async () => undefined,
    github: () => null,
    gitlab: () => ({ groups: async () => [], group: async () => null }),
    bind: vi.fn(async () => "rpb_test"),
    notifyReauthorize: async () => undefined,
    steeringHook: () => {
      throw new Error("bind_repository registers no hook");
    },
    startToolMigration: start,
    ...overrides,
  };
  return { deps, saved, order, start };
}

beforeEach(() => {
  mocks.warn.mockReset();
  mocks.info.mockReset();
  mocks.runToolMigration.mockReset();
});

describe("the start of the tool migration on provisioning", () => {
  it("starts the migration once bind_repository makes the workspace's repo ready", async () => {
    const h = harness();

    await expect(runSteeringRepoStep(h.deps, WORKSPACE, "bind_repository")).resolves.toEqual({
      step: "bind_repository",
      status: "ready",
      ran: true,
    });

    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith(WORKSPACE);
    // The repo is recorded ready before the migration starts.
    expect(h.order).toEqual(["migrate after ready"]);
    expect(h.saved.at(-1)).toMatchObject({ status: "ready", step: "bind_repository" });
  });

  it("keeps the repo ready when the migration fails to start, and logs it for a retry", async () => {
    const h = harness({
      startToolMigration: vi.fn(async () => {
        throw new Error("GitHub answered 502");
      }),
    });

    await expect(runSteeringRepoStep(h.deps, WORKSPACE, "bind_repository")).resolves.toEqual({
      step: "bind_repository",
      status: "ready",
      ran: true,
    });

    expect(h.saved.at(-1)).toMatchObject({ status: "ready", error: null, failed_step: null });
    expect(mocks.warn).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS, err: "GitHub answered 502" },
      expect.stringContaining("migrate_tools_to_steering retries the move"),
    );
  });

  it("starts it again when the last step runs again, since the migration is safe to repeat", async () => {
    const h = harness();

    await runSteeringRepoStep(h.deps, WORKSPACE, "bind_repository");
    await runSteeringRepoStep(h.deps, WORKSPACE, "bind_repository");

    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("starts nothing when the last step fails", async () => {
    const h = harness({
      bind: vi.fn(async () => {
        throw new Error("the binding write failed");
      }),
    });

    await expect(runSteeringRepoStep(h.deps, WORKSPACE, "bind_repository")).rejects.toThrow(
      "the binding write failed",
    );
    expect(h.start).not.toHaveBeenCalled();
    expect(h.saved.at(-1)).toMatchObject({ status: "failed", failed_step: "bind_repository" });
  });

  it("starts nothing for an organization repo, which holds no workspace's servers", async () => {
    const h = harness();

    // bind_repository does not apply to the organization repo.
    await expect(
      runSteeringRepoStep(h.deps, { kind: "organization", orgId: ORG }, "bind_repository"),
    ).resolves.toMatchObject({ ran: false });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("runs as before when the dependencies carry no start", async () => {
    const h = harness({ startToolMigration: undefined });

    await expect(runSteeringRepoStep(h.deps, WORKSPACE, "bind_repository")).resolves.toMatchObject({
      status: "ready",
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("the production start", () => {
  it("runs migrate_tools_to_steering's run as a service in the workspace's tenant scope", async () => {
    let tenant: unknown = null;
    let attribution: unknown = null;
    mocks.runToolMigration.mockImplementation(async () => {
      tenant = getScope();
      attribution = getPrincipalAttribution();
      return {
        state: "opened",
        pullRequest: { number: 12, url: "https://github.com/acme/oxagen-support/pull/12" },
        pullRequests: [{ number: 12, url: "https://github.com/acme/oxagen-support/pull/12" }],
      };
    });
    const start = steeringRepoProvisionDeps({ actorUserId: "usr_1", env: {} }).startToolMigration;
    if (start === undefined) throw new Error("the production deps carry no startToolMigration");

    await start(WORKSPACE);

    expect(mocks.runToolMigration).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      { actorUserId: null },
      { marker: "migration deps" },
    );
    expect(tenant).toMatchObject({ orgId: ORG, workspaceId: WS });
    expect(attribution).toMatchObject({
      principalKind: "service",
      capabilityName: "migrate_tools_to_steering",
    });
    expect(mocks.info).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS, state: "opened", pullRequests: [12] },
      expect.stringContaining("MCP servers"),
    );
  });

  it("throws the run's refusal, which the step logs", async () => {
    mocks.runToolMigration.mockRejectedValue(new Error("no steering repo"));
    const start = steeringRepoProvisionDeps({ actorUserId: "usr_1", env: {} }).startToolMigration;
    if (start === undefined) throw new Error("the production deps carry no startToolMigration");

    await expect(start(WORKSPACE)).rejects.toThrow("no steering repo");
  });
});
