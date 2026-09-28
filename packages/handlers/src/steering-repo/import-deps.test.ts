// import-deps.test.ts: the production wiring of import_workspace_steering
// (lane S10, #4620). import-run.test.ts runs the steps on in-memory deps and a
// fake host. This file covers what those deps stand in for: the settings
// reads and writes, the lease, the steering head reader, the role changes
// under the workspace lock, the provisioner call, the two host seams, and the
// agent and name reads.
import { schema } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initialImportState,
  STEERING_IMPORT_SETTING,
  type ImportSourceRepository,
} from "./import-run";

/** One builder call on a query chain. */
interface Call {
  method: string;
  args: unknown[];
}

/** One query and every builder call on it. */
interface Chain {
  op: string;
  calls: Call[];
}

const mocks = vi.hoisted(() => {
  const chains: Chain[] = [];
  const results: unknown[][] = [];
  const builderMethods = [
    "from",
    "where",
    "limit",
    "set",
    "returning",
    "innerJoin",
    "leftJoin",
  ];
  // Each select, update, or execute starts a chain that records every builder
  // call. Awaiting a select, or an update with `returning`, resolves the next
  // queued result. Any other update, and every execute, resolves nothing.
  const makeTx = () => {
    const start =
      (op: string) =>
      (...args: unknown[]) => {
        const chain: Chain = { op, calls: [{ method: op, args }] };
        chains.push(chain);
        const builder: Record<string, unknown> = {};
        for (const method of builderMethods)
          builder[method] = (...rest: unknown[]) => {
            chain.calls.push({ method, args: rest });
            return builder;
          };
        builder["then"] = (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          const returning = chain.calls.some((c) => c.method === "returning");
          const value =
            op === "execute" || (op === "update" && !returning)
              ? undefined
              : (results.shift() ?? []);
          return Promise.resolve(value).then(onFulfilled, onRejected);
        };
        return builder;
      };
    return {
      select: start("select"),
      update: start("update"),
      execute: start("execute"),
    };
  };

  class SteeringProvisionBlockedError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  const repository = { owner: "a-intel", name: "platform" };
  const resolveRepository = vi.fn(async (_scope: unknown) => repository);
  return {
    chains,
    results,
    makeTx,
    SteeringProvisionBlockedError,
    repository,
    provisionSteeringRepo: vi.fn(
      async (_deps: unknown, _scope: unknown): Promise<string> => "ready",
    ),
    readSteeringRepoState: vi.fn(
      (
        _settings: unknown,
      ): { status: string; step: string | null; updated_at: string } | null =>
        null,
    ),
    steeringRepoProvisionDeps: vi.fn((options: unknown) => ({
      provisionDeps: options,
    })),
    resolveRepository,
    createSteeringGitHub: vi.fn((_deps: unknown) => ({ resolveRepository })),
    createSteeringHost: vi.fn(() => ({ resolveRepository })),
    resolveGitHubToken: vi.fn(async (_scope: unknown) => "ghs_binding"),
    createGitHubClient: vi.fn((options: { token: string }) => ({
      client: options.token,
    })),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withTenantDb: async (fn: (tx: unknown) => unknown) => fn(mocks.makeTx()),
}));
vi.mock("@oxagen/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/github")>()),
  createGitHubClient: mocks.createGitHubClient,
}));
vi.mock("../context.steering.github", () => ({
  createSteeringGitHub: mocks.createSteeringGitHub,
  resolveGitHubToken: mocks.resolveGitHubToken,
}));
vi.mock("../context.steering.host", () => ({
  createSteeringHost: mocks.createSteeringHost,
}));
vi.mock("../repository.binding-write", () => ({
  workspaceRepositoriesLock: (workspaceId: string) => ({ lock: workspaceId }),
}));
vi.mock("../steering_repo.provision", () => ({
  provisionSteeringRepo: mocks.provisionSteeringRepo,
  readSteeringRepoState: mocks.readSteeringRepoState,
  SteeringProvisionBlockedError: mocks.SteeringProvisionBlockedError,
  steeringRepoProvisionDeps: mocks.steeringRepoProvisionDeps,
}));

import { steeringImportDeps } from "./import-deps";

const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };
const ENV = { OXAGEN_STEERING_APP_ID: "1" };
const SOURCE: ImportSourceRepository = {
  head_id: "head-old",
  connection_id: "conn-1",
  owner: "a-intel",
  name: "platform",
  full_name: "a-intel/platform",
  default_branch: "main",
};

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as SQL);
  return { sql: query.sql, params: query.params };
}

/** The first argument of the named builder call on a chain. */
function argOf(chain: Chain, method: string): unknown {
  const call = chain.calls.find((c) => c.method === method);
  if (!call) throw new Error(`no ${method} call on the ${chain.op} chain`);
  return call.args[0];
}

function chain(index: number): Chain {
  const found = mocks.chains[index];
  if (!found) throw new Error(`no query at index ${index}`);
  return found;
}

/** A head row as the steering head reader selects it. */
function headRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "head-old",
    connectionId: "conn-1",
    provider: "github",
    owner: "a-intel",
    name: "platform",
    fullName: "a-intel/platform",
    defaultBranch: "main",
    connectorId: "github",
    status: "connected",
    deletedAt: null,
    ...overrides,
  };
}

const deps = () => steeringImportDeps({ actorUserId: "u_1", env: ENV });

beforeEach(() => {
  mocks.chains.length = 0;
  mocks.results.length = 0;
  mocks.provisionSteeringRepo.mockReset();
  mocks.provisionSteeringRepo.mockResolvedValue("ready");
  mocks.readSteeringRepoState.mockReset();
  mocks.readSteeringRepoState.mockReturnValue(null);
});

describe("steeringImportDeps: the import state", () => {
  it("reads the state from the workspace's settings", async () => {
    const saved = { ...initialImportState(new Date(0)), status: "done" };
    mocks.results.push([{ settings: { [STEERING_IMPORT_SETTING]: saved } }]);
    await expect(deps().readState(SCOPE)).resolves.toEqual(saved);
    expect(chain(0).op).toBe("select");
    expect(argOf(chain(0), "from")).toBe(schema.workspaces);
    expect(argOf(chain(0), "limit")).toBe(1);
    expect(render(argOf(chain(0), "where")).params).toEqual(["ws_1", "org_1"]);
  });

  it("reads no state from a workspace that never ran an import", async () => {
    mocks.results.push([{ settings: {} }]);
    await expect(deps().readState(SCOPE)).resolves.toBeNull();
  });

  it("refuses a workspace outside the organization", async () => {
    mocks.results.push([]);
    await expect(deps().readState(SCOPE)).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
  });

  it("merges the state into the settings under its own key", async () => {
    const state = initialImportState(new Date("2026-09-28T12:00:00Z"));
    await deps().saveState(SCOPE, state);
    const write = chain(0);
    expect(write.op).toBe("update");
    expect(argOf(write, "update")).toBe(schema.workspaces);
    const settings = render(
      (argOf(write, "set") as { settings: unknown }).settings,
    );
    expect(settings.sql).toContain("jsonb_typeof");
    expect(settings.params).toContain(
      JSON.stringify({ [STEERING_IMPORT_SETTING]: state }),
    );
    expect(render(argOf(write, "where")).params).toEqual(["ws_1", "org_1"]);
  });

  it("takes the lease only when no fresh run holds it", async () => {
    const state = initialImportState(new Date("2026-09-28T12:00:00Z"));
    const staleBefore = new Date("2026-09-28T11:50:00Z");
    mocks.results.push([{ id: "ws_1" }]);
    await expect(deps().claim(SCOPE, state, staleBefore)).resolves.toBe(true);
    const where = render(argOf(chain(0), "where"));
    expect(where.sql).toContain("'running'");
    expect(where.params).toContain(staleBefore.toISOString());
    expect(where.params).toContain(`{${STEERING_IMPORT_SETTING},status}`);
    expect(where.params).toContain(`{${STEERING_IMPORT_SETTING},updated_at}`);
  });

  it("answers false when another run holds the lease", async () => {
    mocks.results.push([]);
    await expect(
      deps().claim(SCOPE, initialImportState(new Date()), new Date()),
    ).resolves.toBe(false);
  });
});

describe("steeringImportDeps: the steering head", () => {
  it("reads a head on the Oxagen Steering app as a provisioned steering repo", async () => {
    mocks.results.push([
      headRow({ connectorId: "github_steering", fullName: "a-intel/platform-steering" }),
    ]);
    await expect(deps().readSteeringHead(SCOPE)).resolves.toEqual({
      kind: "provisioned",
      fullName: "a-intel/platform-steering",
    });
    expect(mocks.chains).toHaveLength(1);
  });

  it("reads a head on the GitLab steering connector as provisioned", async () => {
    mocks.results.push([
      headRow({ provider: "gitlab", connectorId: "gitlab_steering" }),
    ]);
    await expect(deps().readSteeringHead(SCOPE)).resolves.toMatchObject({
      kind: "provisioned",
    });
  });

  it("reads a GitLab code repository as a host the import does not read", async () => {
    mocks.results.push([
      headRow({ provider: "gitlab", connectorId: "gitlab", fullName: "acme/app" }),
    ]);
    await expect(deps().readSteeringHead(SCOPE)).resolves.toEqual({
      kind: "unsupported",
      provider: "gitlab",
      fullName: "acme/app",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no connection", { connectorId: null, status: null }],
    ["a deleted connection", { deletedAt: new Date("2026-09-01T00:00:00Z") }],
    ["a connection being deleted", { status: "deleting" }],
    ["a connection marked deleted", { status: "deleted" }],
  ])("reads a head with %s as unreachable", async (_name, overrides) => {
    mocks.results.push([headRow(overrides)]);
    await expect(deps().readSteeringHead(SCOPE)).resolves.toEqual({
      kind: "unreachable",
      fullName: "a-intel/platform",
    });
  });

  it("reads a connected GitHub head as the repository the import reads", async () => {
    mocks.results.push([headRow()]);
    await expect(deps().readSteeringHead(SCOPE)).resolves.toEqual({
      kind: "repository",
      ...SOURCE,
    });
    const read = chain(0);
    expect(argOf(read, "from")).toBe(schema.repositoryBindingHeads);
    expect(argOf(read, "innerJoin")).toBe(schema.repositoryBindings);
    expect(argOf(read, "leftJoin")).toBe(schema.sourceConnections);
    expect(render(argOf(read, "where")).params).toEqual([
      "org_1",
      "ws_1",
      ...schema.STEERING_HEAD_ROLES,
    ]);
  });

  it("reads a sources connection that names a repository as legacy", async () => {
    mocks.results.push([], [{ deliveryConfig: { owner: "a-intel", repo: "platform" } }]);
    await expect(deps().readSteeringHead(SCOPE)).resolves.toEqual({
      kind: "legacy",
      fullName: "a-intel/platform",
    });
    expect(argOf(chain(1), "from")).toBe(schema.sourceConnections);
  });

  it.each<[string, unknown[]]>([
    ["no sources connection", []],
    ["a connection with no delivery config", [{ deliveryConfig: null }]],
    ["a connection that names no repository", [{ deliveryConfig: { owner: "a-intel" } }]],
  ])("reads a workspace with %s as none", async (_name, legacy) => {
    mocks.results.push([], legacy);
    await expect(deps().readSteeringHead(SCOPE)).resolves.toEqual({
      kind: "none",
    });
  });
});

describe("steeringImportDeps: the head's role", () => {
  it("demotes the head to linked under the workspace lock", async () => {
    mocks.results.push([{ id: "head-old" }]);
    await expect(deps().demote(SCOPE, "head-old")).resolves.toBe(true);
    expect(chain(0).op).toBe("execute");
    expect(argOf(chain(0), "execute")).toEqual({ lock: "ws_1" });
    const write = chain(1);
    expect(write.op).toBe("update");
    expect(argOf(write, "update")).toBe(schema.repositoryBindingHeads);
    expect(argOf(write, "set")).toMatchObject({ role: "linked" });
    expect(render(argOf(write, "where")).params).toEqual([
      "head-old",
      "org_1",
      "ws_1",
    ]);
  });

  it("answers false when the head is gone", async () => {
    mocks.results.push([]);
    await expect(deps().demote(SCOPE, "head-old")).resolves.toBe(false);
  });

  it("restores a linked head while the workspace has no steering head", async () => {
    mocks.results.push([], [{ id: "head-old" }]);
    await expect(deps().restore(SCOPE, "head-old")).resolves.toBe(true);
    expect(mocks.chains.map((c) => c.op)).toEqual(["execute", "select", "update"]);
    expect(argOf(chain(2), "set")).toMatchObject({ role: "steering" });
    expect(render(argOf(chain(2), "where")).params).toEqual([
      "head-old",
      "org_1",
      "ws_1",
      "linked",
    ]);
  });

  it("leaves the head linked once the new steering repo is bound", async () => {
    mocks.results.push([{ id: "head-steering" }]);
    await expect(deps().restore(SCOPE, "head-old")).resolves.toBe(false);
    expect(mocks.chains.map((c) => c.op)).toEqual(["execute", "select"]);
  });
});

describe("steeringImportDeps: provisioning", () => {
  beforeEach(() => {
    mocks.results.push([{ settings: {} }]);
  });

  it("does nothing when the steering repo is ready", async () => {
    mocks.readSteeringRepoState.mockReturnValue({
      status: "ready",
      step: null,
      updated_at: new Date().toISOString(),
    });
    await deps().provision(SCOPE);
    expect(mocks.provisionSteeringRepo).not.toHaveBeenCalled();
  });

  it("waits for a provisioning run that saved in the last ten minutes", async () => {
    mocks.readSteeringRepoState.mockReturnValue({
      status: "provisioning",
      step: "create_repository",
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(deps().provision(SCOPE)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_provisioning",
    });
    expect(mocks.provisionSteeringRepo).not.toHaveBeenCalled();
  });

  it("runs the provisioner for the workspace when a run went quiet", async () => {
    mocks.readSteeringRepoState.mockReturnValue({
      status: "provisioning",
      step: "create_repository",
      updated_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    await deps().provision(SCOPE);
    expect(mocks.steeringRepoProvisionDeps).toHaveBeenCalledWith({
      actorUserId: "u_1",
      env: ENV,
    });
    expect(mocks.provisionSteeringRepo).toHaveBeenCalledWith(
      { provisionDeps: { actorUserId: "u_1", env: ENV } },
      { kind: "workspace", orgId: "org_1", workspaceId: "ws_1" },
    );
  });

  it("passes no env when the caller gave none", async () => {
    await steeringImportDeps({ actorUserId: "u_1" }).provision(SCOPE);
    expect(mocks.steeringRepoProvisionDeps).toHaveBeenLastCalledWith({
      actorUserId: "u_1",
    });
  });

  it("refuses a provisioner that stops short of ready", async () => {
    mocks.provisionSteeringRepo.mockResolvedValue("failed");
    await expect(deps().provision(SCOPE)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_provision_failed",
      message: expect.stringContaining("status failed"),
    });
  });

  it("passes a HandlerError through", async () => {
    const refusal = new HandlerError({
      code: "forbidden",
      reason: "steering_app_not_installed",
      message: "Install the Oxagen Steering app.",
    });
    mocks.provisionSteeringRepo.mockRejectedValue(refusal);
    await expect(deps().provision(SCOPE)).rejects.toBe(refusal);
  });

  it("turns a blocked provisioner into a conflict with its code", async () => {
    mocks.provisionSteeringRepo.mockRejectedValue(
      new mocks.SteeringProvisionBlockedError(
        "steering_repo_name_taken",
        "The name is taken.",
      ),
    );
    await expect(deps().provision(SCOPE)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_name_taken",
      message: "The name is taken.",
    });
  });

  it.each<[string, unknown, string]>([
    ["an Error", new Error("socket hang up"), "socket hang up"],
    ["a thrown string", "timeout", "timeout"],
  ])("turns %s into a provision failure", async (_name, thrown, message) => {
    mocks.provisionSteeringRepo.mockRejectedValue(thrown);
    await expect(deps().provision(SCOPE)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_provision_failed",
      message,
    });
  });
});

describe("steeringImportDeps: the hosts", () => {
  it("opens the old repository through its binding and connection", async () => {
    const opened = await deps().openSource(SCOPE, SOURCE);
    expect(opened.repo).toBe(mocks.repository);
    expect(mocks.resolveRepository).toHaveBeenLastCalledWith(SCOPE);

    const seam = mocks.createSteeringGitHub.mock.calls.at(-1)?.[0] as {
      readConnection: () => Promise<unknown>;
      resolveToken: (scope: typeof SCOPE) => Promise<unknown>;
      client: (token: string) => unknown;
    };
    await expect(seam.readConnection()).resolves.toEqual({
      source: "binding",
      owner: "a-intel",
      repo: "platform",
      approvedFullName: "a-intel/platform",
      approvedDefaultRef: "main",
    });
    await expect(seam.resolveToken(SCOPE)).resolves.toBe("ghs_binding");
    expect(mocks.resolveGitHubToken).toHaveBeenLastCalledWith({
      ...SCOPE,
      connectionId: "conn-1",
    });
    expect(seam.client("ghs_binding")).toEqual({ client: "ghs_binding" });
    expect(mocks.createGitHubClient).toHaveBeenLastCalledWith({
      token: "ghs_binding",
    });
  });

  it("opens the steering repo through the steering host", async () => {
    const opened = await deps().openSteering(SCOPE);
    expect(mocks.createSteeringHost).toHaveBeenCalled();
    expect(opened.repo).toBe(mocks.repository);
    expect(mocks.resolveRepository).toHaveBeenLastCalledWith(SCOPE);
  });
});

describe("steeringImportDeps: agents and names", () => {
  it("reads the workspace's agents with no operator", async () => {
    mocks.results.push([
      { slug: "release-bot", label: "Release bot", harness: "claude-code", runtime: "local" },
      { slug: "ci-reviewer", label: "CI reviewer", harness: "codex", runtime: null },
    ]);
    await expect(deps().agents(SCOPE)).resolves.toEqual([
      {
        slug: "release-bot",
        label: "Release bot",
        operator: null,
        runtime: "local",
        harness: "claude-code",
      },
      {
        slug: "ci-reviewer",
        label: "CI reviewer",
        operator: null,
        runtime: null,
        harness: "codex",
      },
    ]);
    expect(argOf(chain(0), "from")).toBe(schema.agents);
    expect(argOf(chain(0), "leftJoin")).toBe(schema.runtimes);
  });

  it("reads the organization and workspace slugs", async () => {
    mocks.results.push([{ organization: "a-intel", workspace: "platform" }]);
    await expect(deps().names(SCOPE)).resolves.toEqual({
      organization: "a-intel",
      workspace: "platform",
    });
    expect(argOf(chain(0), "innerJoin")).toBe(schema.organizations);
  });

  it("refuses names for a workspace outside the organization", async () => {
    mocks.results.push([]);
    await expect(deps().names(SCOPE)).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
  });

  it("reads the clock", () => {
    const before = Date.now();
    const now = deps().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
