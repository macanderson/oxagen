// create_workspace (lane S1, #4450): the role gate, the org and slug checks,
// one transaction that writes the workspace and the first state of its
// steering_repo setting, and the provision request that follows the commit.
// The role gate and the workspace bootstrap run for real against a faked
// tenant transaction. The seeds the bootstrap calls are stubbed, and so is
// the event client the default provision request sends through.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  wsFindFirst: vi.fn(),
  txInsertWs: vi.fn(),
  txInsertWsReturning: vi.fn(),
  txInsertWsUsers: vi.fn(),
  /** The insert count at each mid-transaction scope move the bootstrap makes (#3029). */
  txScopeMoves: [] as number[],
  /** Every `tx.insert(table).values(v)` a tenant transaction issues, in order. */
  inserts: [] as Array<{
    table: unknown;
    values: Record<string, unknown>;
    /** Which `withTenantDb` call (0-based) the insert ran inside. */
    txIndex: number;
  }>,
  /** Every `tx.update(table).set(v).where(w)` a tenant transaction issues. */
  updates: [] as Array<{
    table: unknown;
    values: Record<string, unknown>;
    where: unknown;
    txIndex: number;
    /** How many inserts that transaction had issued before this update. */
    afterInserts: number;
  }>,
  /** Every update a system transaction issues: the failed-request record. */
  systemUpdates: [] as Array<{
    table: unknown;
    values: Record<string, unknown>;
    where: unknown;
  }>,
  /** The transaction object each `withTenantDb` call handed its callback. */
  txs: [] as unknown[],
  /** A failure the settings update raises inside the creating transaction. */
  updateError: null as unknown,
  /** The actor's principal, org role and workspace role, as assertOrgRole reads them. */
  tenant: {
    principalId: "prn_1" as string | null,
    roleName: "Owner" as string | null,
    workspaceRoleName: null as string | null,
    /** The creator an API key resolves to, or none. */
    keyCreator: "u_1" as string | null,
  },
  /** Stands in for claimOnboardingGateWorkspace. Reports that no gate was open. */
  claimGate: vi.fn(
    async (
      _tx: unknown,
      _args: { orgId: string; workspaceId: string; now: Date },
    ): Promise<boolean> => false,
  ),
  emitSecurityEventAsync: vi.fn(
    async (_event: Record<string, unknown>): Promise<void> => undefined,
  ),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  send: vi.fn(
    async (_event: { name: string; data: unknown }): Promise<void> =>
      undefined,
  ),
}));

// The bootstrap's seeds have their own tests. Here they only show which
// transaction they ran on.
vi.mock("./workspace-agents", () => ({
  bootstrapWorkspaceAgents: vi.fn(async () => undefined),
}));
vi.mock("./workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistry: vi.fn(async () => "mreg_stub"),
}));
vi.mock("./workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironment: vi.fn(async () => "env_stub_id"),
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

vi.mock("./logger", () => ({ logger: mocks.logger }));

// requestSteeringRepoProvision imports the event client lazily. The mock
// applies to that dynamic import too, so no test needs a live Inngest.
vi.mock("./event-client", () => ({ eventClient: { send: mocks.send } }));

// The gate claim runs against a real database in org.create.pg.test.ts. Here
// it only shows which transaction it ran on and what it was given (#4582).
vi.mock("./lib/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/onboarding")>()),
  claimOnboardingGateWorkspace: mocks.claimGate,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dialect = new PgDialect();
  // The org-wide seam is mocked as the same function as the tenant seam
  // (ADR-086). The role gate reads through withOrgDb, and a suite that counts
  // seam calls must see one identity.
  const dbMock = {
    ...real,
    // startSteeringRepoProvision records a failed request through
    // saveSteeringRepoState, which writes on a system transaction.
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: async (where: unknown) => {
              mocks.systemUpdates.push({ table, values, where });
              return [];
            },
          }),
        }),
      }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Each call gets its own insert counter, so the reads and the creating
      // transaction each start from zero.
      const insertCountRef = { n: 0 };
      const txIndex = mocks.txs.length;
      const tx = {
        // The bootstrap re-points app.current_workspace_id on this
        // transaction once the workspace row exists (#3029).
        execute: async () => {
          mocks.txScopeMoves.push(insertCountRef.n);
          return undefined;
        },
        query: {
          organizations: { findFirst: mocks.orgFindFirst },
          workspaces: { findFirst: mocks.wsFindFirst },
        },
        // The role gate reads the API key, the principal and the role
        // assignments. It tells an org-wide assignment from a workspace one
        // by the scope the WHERE pins. The bootstrap reads the org's
        // workspace namespaces, and an empty answer keeps the slug as the
        // namespace.
        select: () => ({
          from: (table: unknown) => {
            let lastWhere: SQL | null = null;
            const answer = (): unknown[] => {
              if (table === real.schema.apiKeys)
                return mocks.tenant.keyCreator
                  ? [{ createdById: mocks.tenant.keyCreator }]
                  : [];
              if (table === real.schema.principals)
                return mocks.tenant.principalId
                  ? [{ id: mocks.tenant.principalId }]
                  : [];
              if (table === real.schema.principalRoleAssignments) {
                const pinsWorkspace =
                  lastWhere !== null &&
                  /"workspace_id" = \$/.test(dialect.sqlToQuery(lastWhere).sql);
                const name = pinsWorkspace
                  ? mocks.tenant.workspaceRoleName
                  : mocks.tenant.roleName;
                return name ? [{ roleName: name }] : [];
              }
              return [];
            };
            const chain = {
              innerJoin: () => chain,
              where: (cond: SQL) => {
                lastWhere = cond;
                return Object.assign(Promise.resolve(answer()), chain);
              },
              orderBy: () => Object.assign(Promise.resolve(answer()), chain),
              limit: () => Promise.resolve(answer()),
            };
            return chain;
          },
        }),
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: async (where: unknown) => {
              mocks.updates.push({
                table,
                values,
                where,
                txIndex,
                afterInserts: insertCountRef.n,
              });
              if (mocks.updateError) throw mocks.updateError;
              return [];
            },
          }),
        }),
        insert: (table: unknown): unknown => {
          insertCountRef.n++;
          const stub = (
            table === real.schema.workspaces
              ? mocks.txInsertWs(table)
              : mocks.txInsertWsUsers(table)
          ) as { values: (v: Record<string, unknown>) => unknown };
          return {
            values: (v: Record<string, unknown>) => {
              mocks.inserts.push({ table, values: v, txIndex });
              return stub.values(v);
            },
          };
        },
      };
      mocks.txs.push(tx);
      return fn(tx);
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { schema } from "@oxagen/database";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import {
  workspaceCreate,
  type WorkspaceCreateInput,
} from "@oxagen/oxagen/contracts/workspace.create";
import type { SteeringRepoProvisionRequest } from "./steering_repo.provision";
import { bootstrapWorkspaceAgents } from "./workspace-agents";
import { seedWorkspaceDefaultEnvironment } from "./workspace-environment-seed";
import { seedWorkspaceDefaultRegistry } from "./workspace-registry-seed";
import {
  createWorkspaceCreateHandler,
  workspaceCreateHandler,
} from "./workspace.create";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const NOW = new Date("2026-09-26T12:00:00.000Z");

/** The row the workspace insert returns. */
const WS_ROW = {
  publicId: "ws_pub_1",
  name: "Platform",
  slug: "platform",
  id: "internal_ws_id",
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

const INPUT: WorkspaceCreateInput = workspaceCreate.input.parse({
  name: "Platform",
  slug: "platform",
});

const MAIN_REPO_WARNING =
  "workspace.create: mainRepo is ignored. A workspace gets a steering repo, and code repositories are linked afterwards.";

const requestProvision = vi.fn(
  async (_data: SteeringRepoProvisionRequest): Promise<void> => undefined,
);
const handler = createWorkspaceCreateHandler({ requestProvision });

const dialect = new PgDialect();

/** The bound parameters of a drizzle SQL fragment. */
function paramsOf(fragment: unknown): unknown[] {
  return dialect.sqlToQuery(fragment as SQL).params;
}

/** The `steering_repo` state a settings merge writes, read from its jsonb patch. */
function steeringStateIn(settings: unknown): unknown {
  const patch = paramsOf(settings).find(
    (p): p is string =>
      typeof p === "string" && p.startsWith('{"steering_repo"'),
  );
  if (patch === undefined) return undefined;
  const parsed = JSON.parse(patch) as { steering_repo?: unknown };
  return parsed.steering_repo;
}

/** The code and reason of the HandlerError a call is refused with. */
async function refusal(
  input: WorkspaceCreateInput,
  ctx: CapabilityContext = CTX,
): Promise<{ code: string; reason: string | undefined }> {
  const err: unknown = await handler(input, ctx).catch((e: unknown) => e);
  if (!isHandlerError(err))
    throw new Error(`expected a HandlerError, got ${String(err)}`);
  return { code: err.code, reason: err.reason };
}

beforeEach(() => {
  mocks.txScopeMoves.length = 0;
  mocks.inserts.length = 0;
  mocks.updates.length = 0;
  mocks.systemUpdates.length = 0;
  mocks.txs.length = 0;
  mocks.updateError = null;
  mocks.tenant.principalId = "prn_1";
  mocks.tenant.roleName = "Owner";
  mocks.tenant.workspaceRoleName = null;
  mocks.tenant.keyCreator = "u_1";
  mocks.orgFindFirst.mockResolvedValue({ slug: "acme" });
  mocks.wsFindFirst.mockResolvedValue(null);
  mocks.txInsertWsReturning.mockResolvedValue([WS_ROW]);
  mocks.txInsertWs.mockReturnValue({
    values: () => ({ returning: mocks.txInsertWsReturning }),
  });
  mocks.txInsertWsUsers.mockReturnValue({
    values: vi.fn(async () => undefined),
  });
});

describe("the create_workspace contract", () => {
  it("accepts a workspace with no mainRepo", () => {
    expect(
      workspaceCreate.input.safeParse({ name: "Test", slug: "test" }).success,
    ).toBe(true);
  });

  it("still accepts the older mainRepo shape and defaults its provider", () => {
    const parsed = workspaceCreate.input.safeParse({
      name: "Test",
      slug: "test",
      mainRepo: { owner: "acme", name: "widgets" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mainRepo?.provider).toBe("github");
  });
});

describe("createWorkspaceCreateHandler: the role gate", () => {
  it("refuses a context with no acting user before any query", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(refusal(INPUT, anonCtx)).resolves.toEqual({
      code: "forbidden",
      reason: "no_principal",
    });
    expect(mocks.txs).toHaveLength(0);
    expect(mocks.orgFindFirst).not.toHaveBeenCalled();
    expect(requestProvision).not.toHaveBeenCalled();
  });

  it.each(["Member", "Billing", "Compliance", "Viewer"])(
    "refuses an org %s with forbidden and org_role_required and writes nothing",
    async (roleName) => {
      mocks.tenant.roleName = roleName;
      await expect(refusal(INPUT)).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(mocks.orgFindFirst).not.toHaveBeenCalled();
      expect(mocks.inserts).toHaveLength(0);
      expect(mocks.updates).toHaveLength(0);
      expect(requestProvision).not.toHaveBeenCalled();
      expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
    },
  );

  it("refuses a workspace Admin with no org role and writes nothing", async () => {
    mocks.tenant.roleName = "Member";
    mocks.tenant.workspaceRoleName = "Admin";
    await expect(refusal(INPUT)).resolves.toEqual({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.inserts).toHaveLength(0);
    expect(requestProvision).not.toHaveBeenCalled();
  });

  it("lets a workspace Owner with no org role create a workspace", async () => {
    mocks.tenant.roleName = "Member";
    mocks.tenant.workspaceRoleName = "Owner";
    await expect(handler(INPUT, CTX)).resolves.toMatchObject({
      publicId: "ws_pub_1",
    });
    expect(mocks.txInsertWs).toHaveBeenCalledTimes(1);
  });

  it("lets an org Admin create a workspace", async () => {
    mocks.tenant.roleName = "Admin";
    await expect(handler(INPUT, CTX)).resolves.toMatchObject({
      slug: "platform",
    });
  });

  describe("an MCP call with an API key and no signed-in user", () => {
    const keyCtx: CapabilityContext = {
      ...CTX,
      userId: null,
      apiKeyId: "aky_1",
      surface: "mcp",
    };

    it("creates the workspace as the key's creator when the creator is an org Owner", async () => {
      await expect(handler(INPUT, keyCtx)).resolves.toMatchObject({
        publicId: "ws_pub_1",
        orgSlug: "acme",
      });
      const wsInsert = mocks.inserts.find((w) => w.table === schema.workspaces);
      expect(wsInsert?.values).toMatchObject({ createdById: "u_1" });
      expect(requestProvision).toHaveBeenCalledWith({
        orgId: CTX.orgId,
        workspaceId: "internal_ws_id",
        actorUserId: "u_1",
      });
    });

    it("refuses a key whose creator is an org Member", async () => {
      mocks.tenant.roleName = "Member";
      await expect(refusal(INPUT, keyCtx)).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(mocks.inserts).toHaveLength(0);
    });

    it("refuses a key that resolves to no creator", async () => {
      mocks.tenant.keyCreator = null;
      await expect(refusal(INPUT, keyCtx)).resolves.toEqual({
        code: "forbidden",
        reason: "no_principal",
      });
      expect(mocks.orgFindFirst).not.toHaveBeenCalled();
    });
  });
});

describe("createWorkspaceCreateHandler: the org and slug checks", () => {
  it("refuses with not_found and org_not_found when the org row is missing", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce(null);
    await expect(refusal(INPUT)).resolves.toEqual({
      code: "not_found",
      reason: "org_not_found",
    });
    expect(mocks.wsFindFirst).not.toHaveBeenCalled();
    expect(mocks.inserts).toHaveLength(0);
    expect(requestProvision).not.toHaveBeenCalled();
  });

  it("reads the org by the context's orgId and pre-checks the slug in that org", async () => {
    await handler(INPUT, CTX);
    expect(mocks.orgFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.wsFindFirst).toHaveBeenCalledTimes(1);
    expect(paramsOf(mocks.orgFindFirst.mock.calls[0]?.[0]?.where)).toEqual([
      CTX.orgId,
    ]);
    expect(paramsOf(mocks.wsFindFirst.mock.calls[0]?.[0]?.where)).toEqual([
      CTX.orgId,
      "platform",
    ]);
  });

  it("refuses a slug the pre-check finds with conflict and slug_taken, and writes nothing", async () => {
    mocks.wsFindFirst.mockResolvedValueOnce({ id: "existing_ws" });
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slug_taken",
      message:
        "A workspace with the slug platform already exists in this organization",
    });
    expect(mocks.inserts).toHaveLength(0);
    expect(mocks.updates).toHaveLength(0);
    expect(requestProvision).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("refuses a slug lost to a concurrent create inside the transaction with conflict and slug_taken", async () => {
    mocks.txInsertWsReturning.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value"), {
        code: "23505",
        constraint_name: "workspaces_org_id_slug_idx",
      }),
    );
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slug_taken",
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { orgId: CTX.orgId, slug: "platform" },
      "workspace.create: slug conflict (race)",
    );
    expect(mocks.updates).toHaveLength(0);
    expect(requestProvision).not.toHaveBeenCalled();
  });

  it("rethrows any other transaction error unchanged and starts no job", async () => {
    const failure = new Error("connection reset");
    mocks.txInsertWsReturning.mockRejectedValueOnce(failure);
    await expect(handler(INPUT, CTX)).rejects.toBe(failure);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { err: failure, orgId: CTX.orgId },
      "workspace.create: transaction failed",
    );
    expect(requestProvision).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("throws when the workspace insert returns no row", async () => {
    mocks.txInsertWsReturning.mockResolvedValueOnce([]);
    await expect(handler(INPUT, CTX)).rejects.toThrow(
      "workspace insert returned no row",
    );
    expect(requestProvision).not.toHaveBeenCalled();
  });
});

describe("createWorkspaceCreateHandler: the creating transaction", () => {
  it("moves the transaction's workspace scope onto the new workspace before any workspace-scoped row", async () => {
    await handler(INPUT, CTX);
    // One move, after insert 1 (workspaces). Insert 2 (workspace_users), the
    // seeds and the settings update all run under the new workspace.
    expect(mocks.txScopeMoves).toEqual([1]);
    expect(mocks.txInsertWsUsers).toHaveBeenCalled();
  });

  it("writes the first steering_repo state on the new workspace in the same transaction as the bootstrap", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      await handler(INPUT, CTX);
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.updates).toHaveLength(1);
    const update = mocks.updates[0];
    const wsInsert = mocks.inserts.find((w) => w.table === schema.workspaces);
    expect(update?.table).toBe(schema.workspaces);
    expect(update?.txIndex).toBe(wsInsert?.txIndex);
    // The update follows the workspace and workspace_users inserts.
    expect(update?.afterInserts).toBe(2);
    expect(paramsOf(update?.where)).toEqual(["internal_ws_id"]);
    expect(steeringStateIn(update?.values.settings)).toEqual({
      status: "provisioning",
      step: null,
      failed_step: null,
      error: null,
      provider: null,
      attempt: 1,
      candidate: null,
      repository: null,
      commit_sha: null,
      deployment_id: null,
      binding_id: null,
      updated_at: NOW.toISOString(),
    });
  });

  it("seeds the built-in agent, the default registry and the default environment on the transaction that writes the settings", async () => {
    await handler(INPUT, CTX);
    const seeded = { orgId: CTX.orgId, workspaceId: "internal_ws_id" };
    expect(bootstrapWorkspaceAgents).toHaveBeenCalledWith(
      expect.objectContaining({ ...seeded, userId: CTX.userId }),
    );
    expect(seedWorkspaceDefaultRegistry).toHaveBeenCalledWith(
      expect.objectContaining(seeded),
    );
    expect(seedWorkspaceDefaultEnvironment).toHaveBeenCalledWith(
      expect.objectContaining(seeded),
    );
    const txs = new Set<unknown>([
      vi.mocked(bootstrapWorkspaceAgents).mock.calls[0]?.[0]?.tx,
      vi.mocked(seedWorkspaceDefaultRegistry).mock.calls[0]?.[0]?.tx,
      vi.mocked(seedWorkspaceDefaultEnvironment).mock.calls[0]?.[0]?.tx,
    ]);
    expect(txs.size).toBe(1);
    const updateTx = mocks.txs[mocks.updates[0]?.txIndex ?? -1];
    expect(updateTx).toBeDefined();
    expect(txs.has(updateTx)).toBe(true);
  });

  it("claims an open onboarding gate for the new workspace on the creating transaction", async () => {
    await handler(INPUT, CTX);
    expect(mocks.claimGate).toHaveBeenCalledTimes(1);
    const [claimTx, args] = mocks.claimGate.mock.calls[0] ?? [];
    const updateTx = mocks.txs[mocks.updates[0]?.txIndex ?? -1];
    expect(updateTx).toBeDefined();
    expect(claimTx).toBe(updateTx);
    expect(args).toEqual({
      orgId: CTX.orgId,
      workspaceId: WS_ROW.id,
      now: expect.any(Date),
    });
  });

  it("fails the create and starts no job when the settings write fails", async () => {
    const failure = new Error("settings write refused");
    mocks.updateError = failure;
    await expect(handler(INPUT, CTX)).rejects.toBe(failure);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { err: failure, orgId: CTX.orgId },
      "workspace.create: transaction failed",
    );
    expect(requestProvision).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });
});

describe("createWorkspaceCreateHandler: the provision request", () => {
  it("requests provisioning for the new workspace after the transaction commits", async () => {
    let updatesAtRequest = -1;
    requestProvision.mockImplementationOnce(async () => {
      updatesAtRequest = mocks.updates.length;
    });
    await handler(INPUT, CTX);
    expect(requestProvision).toHaveBeenCalledTimes(1);
    expect(requestProvision).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: "internal_ws_id",
      actorUserId: "u_1",
    });
    expect(updatesAtRequest).toBe(1);
  });

  it("returns the workspace, its org slug and a provisioning steering repo", async () => {
    const out = await handler(INPUT, CTX);
    expect(out).toEqual({
      publicId: "ws_pub_1",
      name: "Platform",
      slug: "platform",
      orgSlug: "acme",
      createdAt: "2026-05-01T00:00:00.000Z",
      steering_repo: { status: "provisioning" },
    });
    expect(workspaceCreate.output.safeParse(out).success).toBe(true);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "internal_ws_id",
        orgId: CTX.orgId,
        steeringRepo: "provisioning",
      }),
      "workspace.create: workspace created, steering repo provisioning started",
    );
    expect(mocks.systemUpdates).toHaveLength(0);
  });

  it("returns a failed steering repo without throwing when the request fails, and records the failure", async () => {
    requestProvision.mockRejectedValueOnce(new Error("inngest unreachable"));
    const out = await handler(INPUT, CTX);

    expect(out.publicId).toBe("ws_pub_1");
    expect(out.steering_repo).toEqual({ status: "failed" });
    expect(workspaceCreate.output.safeParse(out).success).toBe(true);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: CTX.orgId,
        workspaceId: "internal_ws_id",
      }),
      "steering_repo.provision: could not queue the provision job",
    );
    expect(mocks.systemUpdates).toHaveLength(1);
    const saved = mocks.systemUpdates[0];
    expect(saved?.table).toBe(schema.workspaces);
    expect(paramsOf(saved?.where)).toEqual(["internal_ws_id", CTX.orgId]);
    expect(steeringStateIn(saved?.values.settings)).toMatchObject({
      status: "failed",
      error: { code: "enqueue_failed", message: "inngest unreachable" },
    });
    // The workspace exists, so its security event is still recorded.
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledTimes(1);
  });
});

describe("createWorkspaceCreateHandler: a deprecated mainRepo", () => {
  it("logs a warning for a GitHub mainRepo and binds nothing", async () => {
    const input = workspaceCreate.input.parse({
      name: "Platform",
      slug: "platform",
      mainRepo: { owner: "acme", name: "widgets" },
    });
    const out = await handler(input, CTX);

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { orgId: CTX.orgId, surface: CTX.surface },
      MAIN_REPO_WARNING,
    );
    expect(out).not.toHaveProperty("mainRepo");
    expect(out.steering_repo).toEqual({ status: "provisioning" });
    // Only the workspace and its owner membership are inserted: no
    // connection, binding or head.
    expect(mocks.inserts).toHaveLength(2);
    expect(
      mocks.inserts.every(
        (w) =>
          w.table === schema.workspaces || w.table === schema.workspaceUsers,
      ),
    ).toBe(true);
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0]?.table).toBe(schema.workspaces);
  });

  it("logs a warning for a GitLab mainRepo and writes no part of its token", async () => {
    const token = "glpat-abcdefghijklmnopqrstuvwxyz";
    const input = workspaceCreate.input.parse({
      name: "Platform",
      slug: "platform",
      mainRepo: {
        provider: "gitlab",
        projectPath: "acme/platform/rules",
        token,
      },
    });
    await handler(input, CTX);

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { orgId: CTX.orgId, surface: CTX.surface },
      MAIN_REPO_WARNING,
    );
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mocks.inserts.map((w) => w.values))).not.toContain(
      token,
    );
    expect(mocks.inserts).toHaveLength(2);
  });

  it("logs no warning when the input carries no mainRepo", async () => {
    await handler(INPUT, CTX);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });
});

describe("createWorkspaceCreateHandler: the security event", () => {
  it("records a workspace.created security event for the creator", async () => {
    await handler(INPUT, CTX);
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith({
      eventType: "workspace.created",
      actorUserId: "u_1",
      orgId: CTX.orgId,
      workspaceId: "internal_ws_id",
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: CTX.requestId,
    });
  });

  it("logs and swallows a security event that fails to record", async () => {
    const failure = new Error("audit store down");
    mocks.emitSecurityEventAsync.mockRejectedValueOnce(failure);
    await expect(handler(INPUT, CTX)).resolves.toMatchObject({
      publicId: "ws_pub_1",
      steering_repo: { status: "provisioning" },
    });
    await vi.waitFor(() => {
      expect(mocks.logger.error).toHaveBeenCalledWith(
        { err: failure, orgId: CTX.orgId, workspaceId: "internal_ws_id" },
        "workspace.create: failed to record security event",
      );
    });
  });
});

describe("workspaceCreateHandler", () => {
  it("sends steering-repo/provision.requested through the event client", async () => {
    await expect(workspaceCreateHandler(INPUT, CTX)).resolves.toMatchObject({
      steering_repo: { status: "provisioning" },
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      name: "steering-repo/provision.requested",
      data: {
        orgId: CTX.orgId,
        workspaceId: "internal_ws_id",
        actorUserId: "u_1",
      },
    });
  });

  it("returns a failed steering repo when the event client refuses the send", async () => {
    mocks.send.mockRejectedValueOnce(new Error("event key missing"));
    await expect(workspaceCreateHandler(INPUT, CTX)).resolves.toMatchObject({
      steering_repo: { status: "failed" },
    });
    expect(mocks.systemUpdates).toHaveLength(1);
  });
});
