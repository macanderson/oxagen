import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { GitHubRepoInfo } from "@oxagen/github";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  wsFindFirst: vi.fn(),
  txInsertWs: vi.fn(),
  txInsertWsReturning: vi.fn(),
  txInsertWsUsers: vi.fn(),
  txFn: vi.fn(),
  /** The insert count at each mid-transaction scope move the bootstrap makes (#3029). */
  txScopeMoves: [] as number[],
  /**
   * Every `tx.insert(table).values(v)` the creating transaction issues, in
   * order, so a test can say which rows were written — or that none were.
   */
  inserts: [] as Array<{
    table: unknown;
    values: Record<string, unknown>;
    /** Which `withTenantDb` call (0-based) the insert ran inside. */
    txIndex: number;
  }>,
  /** Every `tx.update(table).set(v)` the creating transaction issues. */
  updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  /** The transaction object each `withTenantDb` call handed its callback. */
  txs: [] as unknown[],
  /** A failure the heads insert raises, for the lost-race path. */
  headInsertError: null as unknown,
  /** Rows the shared-plane reads answer, keyed by table. */
  sharedRows: new Map<unknown, unknown[]>(),
  withSystemDbCalls: 0,
  /** The actor's principal, org role and workspace role, as assertOrgRole reads them. */
  tenant: {
    principalId: "prn_1" as string | null,
    roleName: "Owner" as string | null,
    workspaceRoleName: null as string | null,
    /** The creator an API key resolves to, or none. */
    keyCreator: "u_1" as string | null,
  },
  resolveDataPlane: vi.fn(
    async (): Promise<{
      orgId: string;
      kind: "postgres";
      mode: "shared" | "dedicated";
      status: "active";
    }> => ({
      orgId: "org_1",
      kind: "postgres",
      mode: "shared",
      status: "active",
    }),
  ),
  assertDataPlaneUsable: vi.fn(),
  loadDataPlaneBinding: vi.fn(
    async (): Promise<{
      orgId: string;
      kind: "postgres";
      mode: "shared" | "dedicated";
      status: "active";
    }> => ({
      orgId: "org_1",
      kind: "postgres",
      mode: "shared",
      status: "active",
    }),
  ),
  emitSecurityEventAsync: vi.fn(async () => undefined),
}));

// Defaults: org found, no conflicting slug
mocks.orgFindFirst.mockResolvedValue({ slug: "acme" });
mocks.wsFindFirst.mockResolvedValue(null);

mocks.txInsertWsReturning.mockResolvedValue([
  {
    publicId: "ws_pub_1",
    name: "Default Workspace",
    slug: "default",
    id: "internal_ws_id",
    createdAt: new Date("2026-05-01T00:00:00Z"),
  },
]);
const wsValuesStub = { returning: mocks.txInsertWsReturning };
mocks.txInsertWs.mockReturnValue({ values: () => wsValuesStub });
mocks.txInsertWsUsers.mockReturnValue({ values: vi.fn(async () => undefined) });

mocks.txFn.mockImplementation(
  async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
    let insertCount = 0;
    const tx = {
      execute: async () => undefined,
      insert: (table: unknown): unknown => {
        insertCount++;
        if (insertCount === 1) return mocks.txInsertWs(table) as unknown;
        return mocks.txInsertWsUsers(table) as unknown;
      },
    };
    return cb(tx as unknown as Parameters<typeof cb>[0]);
  },
);

// Stub bootstrapWorkspaceAgents to isolate workspace.create tests from DB
// agent-seeding behaviour — that is covered by workspace-agents unit tests.
vi.mock("./workspace-agents", () => ({
  bootstrapWorkspaceAgents: vi.fn(async () => undefined),
}));

// Stub seedWorkspaceDefaultRegistry to isolate workspace.create tests from
// registry-seeding behaviour — that is covered by workspace-registry-seed tests.
vi.mock("./workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistry: vi.fn(async () => "mreg_stub"),
}));

// Stub seedWorkspaceDefaultEnvironment to isolate workspace.create tests from
// environment-seeding behaviour — covered by workspace-environment-seed tests.
vi.mock("./workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironment: vi.fn(async () => "env_stub_id"),
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

vi.mock("@oxagen/database/data-plane", () => ({
  loadDataPlaneBinding: mocks.loadDataPlaneBinding,
}));

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    resolveDataPlane: mocks.resolveDataPlane,
    assertDataPlaneUsable: mocks.assertDataPlaneUsable,
  };
});

/** A drizzle terminal that can be awaited, `.limit()`-ed or `.returning()`-ed. */
function rows(result: unknown[]) {
  return Object.assign(Promise.resolve(result), {
    limit: async () => result,
    returning: async () => result,
  });
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dialect = new PgDialect();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => ({
      query: {
        organizations: { findFirst: mocks.orgFindFirst },
        workspaces: { findFirst: mocks.wsFindFirst },
      },
      transaction: mocks.txFn,
    }),
    // The two cross-tenant reads before the transaction: is any organisation
    // on a dedicated plane, and does another workspace already hold a head,
    // main or linked, for this repository. Answered by table.
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      mocks.withSystemDbCalls += 1;
      return fn({
        select: () => ({
          from: (table: unknown) => ({
            where: () => rows(mocks.sharedRows.get(table) ?? []),
          }),
        }),
      });
    },
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Each withTenantDb call gets its own insert counter so the org-query,
      // ws-query, and transaction calls each see a fresh counter.
      const insertCountRef = { n: 0 };
      const txIndex = mocks.txs.length;
      const tx = {
        // The bootstrap re-points app.current_workspace_id on this transaction
        // once the workspace row exists (#3029) — every row after it lands in a
        // workspace-GUC-scoped table.
        execute: async () => {
          mocks.txScopeMoves.push(insertCountRef.n);
          return undefined;
        },
        query: {
          organizations: { findFirst: mocks.orgFindFirst },
          workspaces: { findFirst: mocks.wsFindFirst },
        },
        // The role gate reads principals then role assignments (answered by
        // table, and for assignments by the scope the WHERE pins: an org-wide
        // assignment has `workspace_id is null`, a workspace assignment
        // carries the id); namespace derivation reads the org's existing
        // workspace namespaces before inserting — empty means the
        // slug-derived namespace is used as-is. Inside the transaction the
        // org's GitHub OAuth account and the connection's latest binding
        // version for the repository are read the same way, and both are
        // empty: no account to link, so the head's binding is version 1.
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
          set: (values: Record<string, unknown>) => {
            mocks.updates.push({ table, values });
            return { where: async () => [] };
          },
        }),
        insert: (table: unknown): unknown => {
          insertCountRef.n++;
          const record = (values: Record<string, unknown>) =>
            mocks.inserts.push({ table, values, txIndex });
          // The workspace row keeps the legacy stub so the existing
          // "returned no row" test still drives it.
          if (table === real.schema.workspaces) {
            const stub = mocks.txInsertWs(table) as {
              values: (v: Record<string, unknown>) => unknown;
            };
            return {
              values: (v: Record<string, unknown>) => {
                record(v);
                return stub.values(v);
              },
            };
          }
          if (table === real.schema.sourceConnections)
            return {
              values: (v: Record<string, unknown>) => {
                record(v);
                return rows([{ id: "conn-uuid", publicId: "con_new" }]);
              },
            };
          if (table === real.schema.repositoryBindings)
            return {
              values: (v: Record<string, unknown>) => {
                record(v);
                return rows([{ id: "binding-uuid", publicId: "rpb_0123abcd" }]);
              },
            };
          if (table === real.schema.repositoryBindingHeads)
            return {
              values: async (v: Record<string, unknown>) => {
                record(v);
                if (mocks.headInsertError) throw mocks.headInsertError;
                return undefined;
              },
            };
          const stub = mocks.txInsertWsUsers(table) as {
            values: (v: Record<string, unknown>) => unknown;
          };
          return {
            values: (v: Record<string, unknown>) => {
              record(v);
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
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { createWorkspaceCreateHandler } from "./workspace.create";
import { FakeGitLabApi } from "./context.steering.gitlab.test-support";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const REPO: GitHubRepoInfo = {
  id: "9001",
  owner: "Acme",
  name: "Widgets",
  fullName: "Acme/Widgets",
  htmlUrl: "https://github.com/Acme/Widgets",
  defaultBranch: "trunk",
};

const INSTALLATION = {
  installationId: "555",
  accountLogin: "Acme",
  accountType: "Organization",
  avatarUrl: null,
  repositorySelection: "all",
};

/**
 * The two GitHub reads the handler makes before its transaction, as fixtures:
 * the org's reachable installations, and the repository through one of them.
 * Each test may override either.
 */
const github = {
  candidates: vi.fn(
    async (): Promise<(typeof INSTALLATION)[] | null> => [INSTALLATION],
  ),
  repository: vi.fn(async (): Promise<GitHubRepoInfo | null> => REPO),
};

const workspaceCreateHandler = createWorkspaceCreateHandler(github);

/** A draft with its main repository — the only shape the contract admits. */
const draft = (name: string, slug: string) => ({
  name,
  slug,
  mainRepo: { provider: "github" as const, owner: "acme", name: "widgets" },
});

describe("workspaceCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.txScopeMoves.length = 0;
    mocks.inserts.length = 0;
    mocks.updates.length = 0;
    mocks.txs.length = 0;
    mocks.headInsertError = null;
    mocks.withSystemDbCalls = 0;
    mocks.sharedRows = new Map<unknown, unknown[]>([
      [schema.dataPlanes, []],
      [schema.repositoryBindingHeads, []],
    ]);
    mocks.orgFindFirst.mockClear();
    mocks.wsFindFirst.mockClear();
    mocks.txFn.mockClear();
    mocks.txInsertWs.mockClear();
    mocks.txInsertWsReturning.mockClear();
    mocks.emitSecurityEventAsync.mockClear();
    github.candidates.mockReset();
    github.repository.mockReset();
    github.candidates.mockResolvedValue([INSTALLATION]);
    github.repository.mockResolvedValue(REPO);
    // Restore defaults
    mocks.tenant.principalId = "prn_1";
    mocks.tenant.roleName = "Owner";
    mocks.tenant.workspaceRoleName = null;
    mocks.tenant.keyCreator = "u_1";
    mocks.orgFindFirst.mockResolvedValue({ slug: "acme" });
    mocks.wsFindFirst.mockResolvedValue(null);
    mocks.txInsertWsReturning.mockResolvedValue([
      {
        publicId: "ws_pub_1",
        name: "Default Workspace",
        slug: "default",
        id: "internal_ws_id",
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
  });

  // ── role gate (INV-29) ────────────────────────────────────────────────────

  async function refusal(
    input: ReturnType<typeof draft>,
    ctx: CapabilityContext = CTX,
  ) {
    const err = await workspaceCreateHandler(input, ctx).catch((e) => e);
    if (!isHandlerError(err))
      throw new Error(`expected a HandlerError, got ${err}`);
    return { code: err.code, reason: err.reason };
  }

  // ── the contract: no workspace without a main repo (§17 M0) ──────────────

  it("the contract refuses a draft with no mainRepo, so the handler can never be reached without one", () => {
    const parsed = workspaceCreate.input.safeParse({
      name: "Test",
      slug: "test",
    });
    expect(parsed.success).toBe(false);
    // And admits one that carries it, defaulting the provider.
    const ok = workspaceCreate.input.safeParse({
      name: "Test",
      slug: "test",
      mainRepo: { owner: "acme", name: "widgets" },
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.mainRepo.provider).toBe("github");
  });

  // #3029 / ADR-068: the app's /{org} create-workspace form and the API's
  // org-only mount both invoke this with ORG_ONLY_WORKSPACE_ID as the scope's
  // workspace, so `app.current_workspace_id` names no workspace when the
  // transaction opens. `workspace.workspaces` is org_only and its INSERT lands,
  // but `workspace.workspace_users` (workspace_only), `agent.agents` and
  // `environments.environments` (standard) are all refused by tenant_isolation's
  // WITH CHECK (42501 — not a unique violation, so it escapes the slug_taken
  // classifier and reaches the caller as a 500). The bootstrap therefore moves
  // the transaction's workspace scope onto the new row the moment it exists,
  // between the workspaces INSERT and everything after it.
  it("moves the transaction's workspace scope onto the new workspace before any workspace-scoped row", async () => {
    await workspaceCreateHandler(draft("Test", "test"), CTX);
    // Exactly one move, and it lands after insert #1 (workspaces) — so insert
    // #2 (workspace_users), the seeds, the connection and the binding all run
    // under the new workspace.
    expect(mocks.txScopeMoves).toEqual([1]);
    expect(mocks.txInsertWsUsers).toHaveBeenCalled();
  });

  it("refuses a context with no user before any query (negative)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(refusal(draft("Test", "test"), anonCtx)).resolves.toEqual({
      code: "forbidden",
      reason: "no_principal",
    });
    expect(mocks.orgFindFirst).not.toHaveBeenCalled();
    expect(github.candidates).not.toHaveBeenCalled();
  });

  describe("an MCP call: an API key and no signed-in user", () => {
    const keyCtx: CapabilityContext = {
      ...CTX,
      userId: null,
      apiKeyId: "aky_1",
      surface: "mcp",
    };

    it("creates the workspace as the key's creator when the creator is an org Owner", async () => {
      await expect(
        workspaceCreateHandler(draft("Test", "test"), keyCtx),
      ).resolves.toMatchObject({ publicId: "ws_pub_1", orgSlug: "acme" });
      // The binding is attributed to the creator, not to nobody.
      const binding = mocks.inserts.find(
        (w) => w.table === schema.repositoryBindings,
      );
      expect(binding?.values).toMatchObject({ createdById: "u_1" });
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      mocks.tenant.roleName = "Member";
      await expect(refusal(draft("Test", "test"), keyCtx)).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(mocks.inserts).toHaveLength(0);
    });

    it("refuses a key that resolves to no creator (negative)", async () => {
      mocks.tenant.keyCreator = null;
      await expect(refusal(draft("Test", "test"), keyCtx)).resolves.toEqual({
        code: "forbidden",
        reason: "no_principal",
      });
      expect(mocks.orgFindFirst).not.toHaveBeenCalled();
    });
  });

  it.each(["Member", "Billing", "Compliance", "Viewer"])(
    "refuses an org %s with forbidden / org_role_required and writes nothing (negative)",
    async (roleName) => {
      mocks.tenant.roleName = roleName;
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(mocks.inserts).toHaveLength(0);
      expect(github.candidates).not.toHaveBeenCalled();
    },
  );

  it("lets a workspace Owner with no org role create a workspace", async () => {
    mocks.tenant.roleName = "Member";
    mocks.tenant.workspaceRoleName = "Owner";
    await expect(
      workspaceCreateHandler(draft("Owned", "owned"), CTX),
    ).resolves.toMatchObject({ publicId: "ws_pub_1" });
    expect(mocks.txInsertWs).toHaveBeenCalledTimes(1);
  });

  it("refuses a workspace Admin with no org role with forbidden / org_role_required and writes nothing (negative)", async () => {
    mocks.tenant.roleName = "Member";
    mocks.tenant.workspaceRoleName = "Admin";
    await expect(refusal(draft("Test", "test"))).resolves.toEqual({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.inserts).toHaveLength(0);
  });

  it("lets an org Admin create a workspace", async () => {
    mocks.tenant.roleName = "Admin";
    const result = await workspaceCreateHandler(
      draft("Admin Ws", "admin-ws"),
      CTX,
    );
    expect(result.slug).toBe("default");
  });

  // ── tenant guard ──────────────────────────────────────────────────────────

  it("refuses with not_found when the org row is missing", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce(null);
    await expect(refusal(draft("Dev", "dev"))).resolves.toEqual({
      code: "not_found",
      reason: "org_not_found",
    });
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("refuses with conflict / slug_taken when the slug already exists in this org, before asking GitHub (negative)", async () => {
    mocks.wsFindFirst.mockResolvedValueOnce({ id: "existing_ws" });
    await expect(refusal(draft("Dupe", "default"))).resolves.toEqual({
      code: "conflict",
      reason: "slug_taken",
    });
    expect(mocks.inserts).toHaveLength(0);
    expect(github.candidates).not.toHaveBeenCalled();
  });

  // ── the main repository: GitHub refusals write nothing (§17 M0) ──────────

  describe("a repository that cannot be bound writes nothing", () => {
    it("github_not_authorized when the org holds no usable GitHub authorization", async () => {
      github.candidates.mockResolvedValueOnce(null);
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "conflict",
        reason: "github_not_authorized",
      });
      expect(mocks.inserts).toHaveLength(0);
      expect(github.repository).not.toHaveBeenCalled();
    });

    it("installation_unreachable when the App is not installed on the repository's owner", async () => {
      github.candidates.mockResolvedValueOnce([
        { ...INSTALLATION, accountLogin: "someone-else" },
      ]);
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "not_found",
        reason: "installation_unreachable",
      });
      expect(mocks.inserts).toHaveLength(0);
      expect(github.repository).not.toHaveBeenCalled();
    });

    it("picks the installation by the repository's owner, case-insensitively, and reads the repository through it", async () => {
      github.candidates.mockResolvedValueOnce([
        { ...INSTALLATION, installationId: "1", accountLogin: "other" },
        { ...INSTALLATION, installationId: "2", accountLogin: "ACME" },
      ]);
      await workspaceCreateHandler(draft("Test", "test"), CTX);
      expect(github.repository).toHaveBeenCalledWith("2", "acme", "widgets");
    });

    it("repository_not_installed when the installation cannot see the repository", async () => {
      github.repository.mockResolvedValueOnce(null);
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "not_found",
        reason: "repository_not_installed",
      });
      expect(mocks.inserts).toHaveLength(0);
      // Refused before the global claim is even asked about.
      expect(mocks.withSystemDbCalls).toBe(0);
    });

    it("main_repo_claimed when another workspace already steers by the repository, naming neither holder", async () => {
      mocks.sharedRows.set(schema.repositoryBindingHeads, [
        { role: "main", workspaceId: "head-elsewhere" },
      ]);
      const err = await workspaceCreateHandler(draft("Test", "test"), CTX).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({
        code: "conflict",
        reason: "main_repo_claimed",
      });
      expect((err as Error).message).toContain("Acme/Widgets");
      expect((err as Error).message).not.toContain("head-elsewhere");
      expect(mocks.inserts).toHaveLength(0);
      expect(mocks.txScopeMoves).toEqual([]);
    });

    // A repository another workspace has LINKED cannot become this one's
    // main either: a main repository holds the `.oxagen/` governance tree,
    // and a linked one receives another workspace's Context PRs.
    it("repository_linked_elsewhere when another workspace has linked the repository, naming neither holder", async () => {
      mocks.sharedRows.set(schema.repositoryBindingHeads, [
        { role: "linked", workspaceId: "head-elsewhere" },
      ]);
      const err = await workspaceCreateHandler(draft("Test", "test"), CTX).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({
        code: "conflict",
        reason: "repository_linked_elsewhere",
      });
      expect((err as Error).message).toContain("Acme/Widgets");
      expect((err as Error).message).not.toContain("head-elsewhere");
      expect(mocks.inserts).toHaveLength(0);
    });

    it("a main head elsewhere wins the sentence over a linked one, as the trigger orders them", async () => {
      mocks.sharedRows.set(schema.repositoryBindingHeads, [
        { role: "linked", workspaceId: "ws-linked" },
        { role: "main", workspaceId: "ws-main" },
      ]);
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "conflict",
        reason: "main_repo_claimed",
      });
    });

    it("main_repo_plane_unsupported while any organisation is on a dedicated Postgres plane", async () => {
      mocks.sharedRows.set(schema.dataPlanes, [{ id: "dpl_other" }]);
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "conflict",
        reason: "main_repo_plane_unsupported",
      });
      expect(mocks.inserts).toHaveLength(0);
    });

    it("main_repo_claimed when the claim is lost mid-transaction to the unique index, with the workspace rolled back", async () => {
      mocks.headInsertError = Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint_name: "repository_binding_heads_main_repository_uq",
        }),
      });
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "conflict",
        reason: "main_repo_claimed",
      });
      // The mock does not roll back, so the proof of atomicity is that the
      // workspace row and the head that lost were written on the ONE
      // transaction that then threw — the real one discards them together
      // (repository.pg.test.ts proves it against Postgres).
      expect(new Set(mocks.inserts.map((w) => w.txIndex)).size).toBe(1);
      expect(mocks.inserts.map((w) => w.table)).toContain(schema.workspaces);
    });

    it("repository_linked_elsewhere when the trigger refuses the main head because a link landed elsewhere mid-transaction, with the workspace rolled back", async () => {
      mocks.headInsertError = Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("trigger refused"), {
          code: "23505",
          constraint_name: "repository_binding_heads_main_is_linked_elsewhere",
        }),
      });
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "conflict",
        reason: "repository_linked_elsewhere",
      });
      expect(new Set(mocks.inserts.map((w) => w.txIndex)).size).toBe(1);
      expect(mocks.inserts.map((w) => w.table)).toContain(schema.workspaces);
    });

    it("lets an unrelated unique violation surface as slug_taken (the slug race), not as a claim", async () => {
      mocks.headInsertError = Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint_name: "workspaces_org_id_slug_uq",
        }),
      });
      await expect(refusal(draft("Test", "test"))).resolves.toEqual({
        code: "conflict",
        reason: "slug_taken",
      });
    });
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns publicId, name, slug, orgSlug, ISO createdAt and the main repository it bound", async () => {
    const result = await workspaceCreateHandler(
      draft("Default Workspace", "default"),
      CTX,
    );

    expect(result).toEqual({
      publicId: "ws_pub_1",
      name: "Default Workspace",
      slug: "default",
      orgSlug: "acme",
      createdAt: "2026-05-01T00:00:00.000Z",
      mainRepo: {
        bindingId: "rpb_0123abcd",
        connectionId: "con_new",
        provider: "github",
        fullName: "Acme/Widgets",
        defaultRef: "trunk",
      },
    });
    expect(workspaceCreate.output.safeParse(result).success).toBe(true);
  });

  it("writes exactly one head, role 'main', with its version-1 binding and a connected GitHub connection, on the workspace's own transaction", async () => {
    await workspaceCreateHandler(draft("Tx Ws", "tx-ws"), CTX);

    const heads = mocks.inserts.filter(
      (w) => w.table === schema.repositoryBindingHeads,
    );
    expect(heads).toHaveLength(1);
    expect(heads[0]?.values).toMatchObject({
      orgId: CTX.orgId,
      workspaceId: "internal_ws_id",
      connectionId: "conn-uuid",
      provider: "github",
      providerRepositoryId: "9001",
      currentBindingId: "binding-uuid",
      role: "main",
    });

    const binding = mocks.inserts.find(
      (w) => w.table === schema.repositoryBindings,
    );
    expect(binding?.values).toMatchObject({
      workspaceId: "internal_ws_id",
      connectionId: "conn-uuid",
      providerRepositoryId: "9001",
      providerOwner: "Acme",
      providerName: "Widgets",
      providerFullName: "Acme/Widgets",
      configuredDefaultRef: "trunk",
      version: 1,
      supersedesBindingId: null,
      createdById: "u_1",
    });

    const connection = mocks.inserts.find(
      (w) => w.table === schema.sourceConnections,
    );
    expect(connection?.values).toMatchObject({
      workspaceId: "internal_ws_id",
      connectorId: "github",
      deliveryConfig: { installationId: "555" },
      status: "connected",
      createdById: "u_1",
    });

    // The workspace row came first, and every row — workspace, membership,
    // connection, binding, head — rode ONE withTenantDb call, the last one
    // (after the role gate, the org read and the slug read).
    expect(mocks.inserts[0]?.table).toBe(schema.workspaces);
    expect(new Set(mocks.inserts.map((w) => w.txIndex))).toEqual(
      new Set([mocks.txs.length - 1]),
    );
    expect(mocks.txInsertWs).toHaveBeenCalledTimes(1);
  });

  it("re-asks which plane the organisation is on, uncached, inside the writing transaction", async () => {
    mocks.loadDataPlaneBinding.mockResolvedValueOnce({
      orgId: "org_1",
      kind: "postgres",
      mode: "dedicated",
      status: "active",
    });
    await expect(refusal(draft("Test", "test"))).resolves.toEqual({
      code: "conflict",
      reason: "main_repo_plane_unsupported",
    });
    // Refused after the bootstrap and before any repository row.
    expect(
      mocks.inserts.filter((w) => w.table === schema.repositoryBindingHeads),
    ).toHaveLength(0);
  });

  it("seeds the built-in agent, the default registry and the default environment on the creating transaction", async () => {
    const [
      { bootstrapWorkspaceAgents },
      { seedWorkspaceDefaultRegistry },
      { seedWorkspaceDefaultEnvironment },
    ] = await Promise.all([
      import("./workspace-agents"),
      import("./workspace-registry-seed"),
      import("./workspace-environment-seed"),
    ]);
    await workspaceCreateHandler(draft("Env Ws", "env-ws"), CTX);
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
    // Every seed rides the same transaction as the workspace row.
    const txs = [
      vi.mocked(bootstrapWorkspaceAgents).mock.calls[0]?.[0]?.tx,
      vi.mocked(seedWorkspaceDefaultRegistry).mock.calls[0]?.[0]?.tx,
      vi.mocked(seedWorkspaceDefaultEnvironment).mock.calls[0]?.[0]?.tx,
    ];
    expect(txs[0]).toBeDefined();
    expect(new Set(txs).size).toBe(1);
  });

  it("records a workspace.created security event for the creator", async () => {
    await workspaceCreateHandler(draft("Audited", "audited"), CTX);
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "workspace.created",
        actorUserId: "u_1",
        orgId: CTX.orgId,
        workspaceId: "internal_ws_id",
        outcome: "success",
      }),
    );
  });

  it("throws when the transaction insert returns no row", async () => {
    mocks.txInsertWsReturning.mockResolvedValueOnce([]);

    await expect(
      workspaceCreateHandler(draft("Empty", "empty"), CTX),
    ).rejects.toThrow("workspace insert returned no row");
  });

  // ── scope isolation ───────────────────────────────────────────────────────

  it("looks up the org by the orgId from context (not from input)", async () => {
    await workspaceCreateHandler(draft("Scoped", "scoped"), CTX);
    // The org query should receive the orgId from CTX, not from user input
    expect(mocks.orgFindFirst).toHaveBeenCalledTimes(1);
  });

  it("slug uniqueness check uses both orgId from context and the input slug", async () => {
    await workspaceCreateHandler(draft("Scoped2", "scoped2"), CTX);
    expect(mocks.wsFindFirst).toHaveBeenCalledTimes(1);
  });
});

/**
 * A GitLab main project (#3762): the token arrives with the request, is
 * verified against gitlab.com (here an in-memory project), and is written
 * sealed with the new workspace's GitLab connection. No GitHub authorization
 * is read.
 */
describe("workspaceCreateHandler with a GitLab main project", () => {
  const TOKEN = "glpat-abcdefghijklmnopqrstuvwxyz";
  const gitlabDraft = {
    name: "Rules",
    slug: "rules",
    mainRepo: {
      provider: "gitlab" as const,
      projectPath: "acme/platform/rules",
      token: TOKEN,
    },
  };

  function handlerWith(api: FakeGitLabApi) {
    const seal = vi.fn(async (plaintext: string) => ({
      keyId: "local:test",
      ciphertext: Buffer.from(`sealed:${plaintext.length}`).toString("base64"),
    }));
    const handler = createWorkspaceCreateHandler({
      ...github,
      gitlab: {
        client: (token) => api.client(token),
        seal,
        newSecret: () => "whsec-fresh",
        webhookUrl: (id) => `https://api.oxagen.test/webhooks/gitlab/${id}`,
      },
    });
    return { handler, seal };
  }

  beforeEach(() => {
    mocks.inserts.length = 0;
    mocks.updates.length = 0;
    mocks.sharedRows = new Map<unknown, unknown[]>([
      [schema.dataPlanes, []],
      [schema.repositoryBindingHeads, []],
    ]);
    github.candidates.mockClear();
    github.repository.mockClear();
  });

  it("creates the workspace with the project bound by id, the token sealed, and the hook registered", async () => {
    const { handler, seal } = handlerWith(new FakeGitLabApi());

    const out = await handler(gitlabDraft, CTX);

    expect(github.candidates).not.toHaveBeenCalled();
    expect(out.mainRepo).toMatchObject({
      provider: "gitlab",
      connectionId: "con_new",
      fullName: "acme/platform/rules",
      defaultRef: "main",
    });
    expect(seal).toHaveBeenCalledWith(
      JSON.stringify({ token: TOKEN, webhookSecret: "whsec-fresh" }),
    );
    const byTable = (t: unknown) => mocks.inserts.find((i) => i.table === t);
    expect(byTable(schema.sourceConnections)?.values).toMatchObject({
      connectorId: "gitlab",
      authScheme: "project_access_token",
      status: "connected",
    });
    expect(byTable(schema.repositoryBindings)?.values).toMatchObject({
      provider: "gitlab",
      providerRepositoryId: "4242",
      providerOwner: "acme/platform",
      providerFullName: "acme/platform/rules",
      configuredDefaultRef: "main",
    });
    expect(byTable(schema.repositoryBindingHeads)?.values).toMatchObject({
      provider: "gitlab",
      role: "main",
    });
    expect(JSON.stringify(mocks.inserts.map((i) => i.values))).not.toContain(
      TOKEN,
    );
    expect(
      mocks.updates.some(
        (u) =>
          (u.values.deliveryConfig as { webhookId?: number })?.webhookId ===
          901,
      ),
    ).toBe(true);
  });

  it("refuses the token from MCP, a runner, or an agent's chat turn, before calling GitLab", async () => {
    const api = new FakeGitLabApi();
    const { handler } = handlerWith(api);
    for (const over of [
      { surface: "mcp" as const },
      { surface: "runner" as const },
      // The in-app agent calls through the app surface inside a chat turn.
      { surface: "app" as const, messageId: "msg_1" },
    ]) {
      const err = await handler(gitlabDraft, { ...CTX, ...over }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ reason: "gitlab_token_surface" });
    }
    expect(api.tokens).toEqual([]);
    expect(mocks.inserts).toEqual([]);
  });

  it("accepts the token from the web app outside a chat turn", async () => {
    const { handler } = handlerWith(new FakeGitLabApi());
    await expect(
      handler(gitlabDraft, { ...CTX, surface: "app" }),
    ).resolves.toMatchObject({ mainRepo: { provider: "gitlab" } });
  });

  it("refuses a token that is not this project's before writing anything", async () => {
    const api = new FakeGitLabApi();
    const { handler } = handlerWith(api);
    const client = api.client.bind(api);
    api.client = (token) => ({
      ...client(token),
      getCurrentUser: async () => ({ id: 3, username: "marcus", bot: false }),
    });
    const err = await handler(gitlabDraft, CTX).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "gitlab_token_not_project_scoped" });
    expect((err as Error).message).not.toContain(TOKEN);
    expect(mocks.inserts).toEqual([]);
  });

  it("refuses a project another workspace already steers by", async () => {
    mocks.sharedRows = new Map<unknown, unknown[]>([
      [schema.dataPlanes, []],
      [schema.repositoryBindingHeads, [{ role: "main", workspaceId: "ws_9" }]],
    ]);
    const { handler } = handlerWith(new FakeGitLabApi());
    await expect(handler(gitlabDraft, CTX)).rejects.toMatchObject({
      reason: "main_repo_claimed",
    });
    expect(mocks.inserts).toEqual([]);
  });
});
