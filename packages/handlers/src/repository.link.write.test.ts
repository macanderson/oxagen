// repository.link.write.ts is the one writer of a linked head (ADR-212).
// `link_repository` runs its checks before it opens a steering PR, and the
// steering sync runs the checks and the write once that steering PR merges.
//
// The database is a fake. `withSystemDb` answers the cross-tenant reads, and
// `withTenantDb` hands over a transaction that records the lock, the heads
// read and the write in the order they happen. The installation resolver and
// the head writer are seams, so each case names what reached them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Tx } from "@oxagen/database";
import type { GitHubRepoInfo } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { workspaceRepositoriesLock } from "./repository.binding-write";
import type { WorkspaceGithubInstallation } from "./repository.github-connection";
import {
  linkRepositoryHead,
  type LinkTarget,
  resolveLinkTarget,
  writeLinkedHead,
} from "./repository.link.write";
import type { MainRepositoryDeps } from "./repository.binding-write";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  resolveWorkspaceGithubInstallation:
    vi.fn<
      typeof import("./repository.github-connection").resolveWorkspaceGithubInstallation
    >(),
  writeRepositoryHead:
    vi.fn<typeof import("./repository.binding-write").writeRepositoryHead>(),
  // Widened so a test can move the organization to a dedicated plane.
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
  // The uncached plane read the write transaction makes (#3340 finding 1).
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
}));

vi.mock("@oxagen/database/data-plane", () => ({
  loadDataPlaneBinding: mocks.loadDataPlaneBinding,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withSystemDb: mocks.withSystemDb,
  };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    resolveDataPlane: mocks.resolveDataPlane,
    assertDataPlaneUsable: mocks.assertDataPlaneUsable,
  };
});

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

vi.mock("./repository.github-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository.github-connection")>()),
  resolveWorkspaceGithubInstallation: mocks.resolveWorkspaceGithubInstallation,
}));

// The lock stays real, so the test compares the statement the writer ran
// against the one the helper builds.
vi.mock("./repository.binding-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository.binding-write")>()),
  writeRepositoryHead: mocks.writeRepositoryHead,
}));

const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };

/** The repository as the installation sees it. GitHub keeps the owner's case. */
const REPO: GitHubRepoInfo = {
  id: "9002",
  owner: "Acme",
  name: "Docs",
  fullName: "Acme/Docs",
  htmlUrl: "https://github.com/Acme/Docs",
  defaultBranch: "main",
};

const CONNECTION: WorkspaceGithubInstallation = {
  id: "conn-uuid",
  publicId: "con_abc",
  status: "connected",
  installationId: "555",
};

const TARGET: LinkTarget = {
  connection: { id: "conn-uuid", publicId: "con_abc" },
  repo: REPO,
};

const NOW = new Date("2026-09-27T12:00:00.000Z");

/** The refusal for another workspace's steering repository, word for word. */
const CLAIMED_MESSAGE =
  "Acme/Docs is the steering repository of another workspace. Its steering record governs that workspace, so it cannot be linked here.";

/** One row of this workspace's heads, as `assertLinkAllowed` selects it. */
interface HeadRow {
  role: string;
  provider: string;
  providerRepositoryId: string;
}

/** This workspace's steering repository, a different GitHub repository. */
const STEERING_HEAD: HeadRow = {
  role: "steering",
  provider: "github",
  providerRepositoryId: "7000",
};

const dialect = new PgDialect();

interface SystemRead {
  table: unknown;
  where: SQL;
}

/**
 * Answer the cross-tenant reads. The data-plane read returns
 * `dedicatedPlanes` and the heads read returns `steeringElsewhere`. Every
 * read is recorded with its table and its predicate.
 */
function armSystemDb(
  opts: { dedicatedPlanes?: unknown[]; steeringElsewhere?: unknown[] } = {},
): SystemRead[] {
  const reads: SystemRead[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: SQL) => {
          reads.push({ table, where });
          return {
            limit: async () => {
              if (table === schema.dataPlanes) return opts.dedicatedPlanes ?? [];
              if (table === schema.repositoryBindingHeads)
                return opts.steeringElsewhere ?? [];
              throw new Error("the system read named a table the test does not know");
            },
          };
        },
      }),
    }),
  };
  mocks.withSystemDb.mockImplementation(
    async (fn: (t: typeof tx) => unknown) => fn(tx),
  );
  return reads;
}

interface Tenant {
  tx: Tx;
  /** "lock", "read", "write" and "promote", in the order the writer reached them. */
  events: string[];
  locks: SQL[];
  reads: SQL[];
  /** Each connection status update: the table, the values, and the filter. */
  updates: { table: unknown; values: Record<string, unknown>; where: SQL }[];
}

/**
 * Hand the writer a transaction whose heads read returns `heads`, and make
 * the head writer record itself and return `rpb_new`.
 */
function armTenant(heads: HeadRow[]): Tenant {
  const events: string[] = [];
  const locks: SQL[] = [];
  const reads: SQL[] = [];
  const updates: Tenant["updates"] = [];
  const fake = {
    execute: async (query: SQL) => {
      events.push("lock");
      locks.push(query);
      return [];
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (where: SQL) => {
          events.push("promote");
          updates.push({ table, values, where });
          return [];
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: async (where: SQL) => {
          if (table !== schema.repositoryBindingHeads)
            throw new Error("the tenant read named a table the test does not know");
          events.push("read");
          reads.push(where);
          return heads;
        },
      }),
    }),
  };
  const tx = fake as unknown as Tx;
  mocks.withTenantDb.mockImplementation(async (fn: (t: Tx) => unknown) =>
    fn(tx),
  );
  mocks.writeRepositoryHead.mockImplementation(async () => {
    events.push("write");
    return { bindingPublicId: "rpb_new" };
  });
  return { tx, events, locks, reads, updates };
}

function deps() {
  return {
    repository: vi.fn<MainRepositoryDeps["repository"]>(async () => REPO),
  };
}

/** A Postgres unique violation the way the driver nests it under `cause`. */
function pg(constraintName: string): Error {
  return Object.assign(new Error("insert failed"), {
    cause: Object.assign(new Error("refused"), {
      code: "23505",
      constraint_name: constraintName,
    }),
  });
}

/** What a call rejects with. The test fails when the call resolves. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("expected the call to be refused");
    },
    (err: unknown) => err,
  );
}

/** The HandlerError a call rejects with. */
async function refusal(call: Promise<unknown>): Promise<HandlerError> {
  const err = await rejection(call);
  expect(err).toBeInstanceOf(HandlerError);
  return err as HandlerError;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveWorkspaceGithubInstallation.mockResolvedValue(CONNECTION);
  mocks.resolveDataPlane.mockResolvedValue({
    orgId: "org_1",
    kind: "postgres",
    mode: "shared",
    status: "active",
  });
  mocks.loadDataPlaneBinding.mockResolvedValue({
    orgId: "org_1",
    kind: "postgres",
    mode: "shared",
    status: "active",
  });
  armSystemDb();
  armTenant([STEERING_HEAD]);
});

describe("resolveLinkTarget", () => {
  it("returns the connection and the repository the installation sees", async () => {
    const d = deps();
    const target = await resolveLinkTarget(SCOPE, "acme", "docs", d);
    expect(target).toEqual(TARGET);
    expect(d.repository.mock.calls).toEqual([["555", "acme", "docs"]]);
    expect(mocks.resolveWorkspaceGithubInstallation).toHaveBeenCalledWith(
      SCOPE,
    );
    expect(mocks.resolveDataPlane).toHaveBeenCalledWith("org_1", "postgres");
  });

  it("refuses with github_not_connected when the workspace has no installation", async () => {
    mocks.resolveWorkspaceGithubInstallation.mockResolvedValue(null);
    const d = deps();
    const err = await refusal(resolveLinkTarget(SCOPE, "acme", "docs", d));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("github_not_connected");
    expect(d.repository).not.toHaveBeenCalled();
  });

  it("refuses with repository_not_installed when the installation cannot see the repository", async () => {
    const d = deps();
    d.repository.mockResolvedValue(null);
    const err = await refusal(resolveLinkTarget(SCOPE, "acme", "docs", d));
    expect(err.code).toBe("not_found");
    expect(err.reason).toBe("repository_not_installed");
    expect(err.message).toBe(
      "The GitHub App installation on this workspace cannot see acme/docs",
    );
    expect(mocks.resolveDataPlane).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("refuses with main_repo_claimed when another workspace holds the repository as its steering repository", async () => {
    armSystemDb({ steeringElsewhere: [{ id: "head-elsewhere" }] });
    const err = await refusal(resolveLinkTarget(SCOPE, "acme", "docs", deps()));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("main_repo_claimed");
    expect(err.message).toBe(CLAIMED_MESSAGE);
    // The read crossed tenants, so the refusal names no organization and no workspace.
    expect(err.message).not.toContain("org_1");
    expect(err.message).not.toContain("ws_1");
  });

  it("reads steering heads for this GitHub repository in other workspaces only", async () => {
    const reads = armSystemDb();
    await resolveLinkTarget(SCOPE, "acme", "docs", deps());
    const heads = reads.find((r) => r.table === schema.repositoryBindingHeads);
    if (!heads) throw new Error("the heads table was not read");
    const query = dialect.sqlToQuery(heads.where);
    expect(query.params).toEqual(["github", "9002", "steering", "ws_1"]);
    expect(query.sql).toContain('"workspace_id" <> $');
  });

  it("checks the data planes before it reads the heads", async () => {
    const reads = armSystemDb();
    await resolveLinkTarget(SCOPE, "acme", "docs", deps());
    expect(reads.map((r) => r.table)).toEqual([
      schema.dataPlanes,
      schema.repositoryBindingHeads,
    ]);
  });

  it("refuses with main_repo_plane_unsupported when the organization is on a dedicated plane", async () => {
    mocks.resolveDataPlane.mockResolvedValue({
      orgId: "org_1",
      kind: "postgres",
      mode: "dedicated",
      status: "active",
    });
    const err = await refusal(resolveLinkTarget(SCOPE, "acme", "docs", deps()));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("main_repo_plane_unsupported");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("refuses with main_repo_plane_unsupported when another organization is on a dedicated plane", async () => {
    const reads = armSystemDb({ dedicatedPlanes: [{ id: "dpl_other" }] });
    const err = await refusal(resolveLinkTarget(SCOPE, "acme", "docs", deps()));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("main_repo_plane_unsupported");
    // A claim it cannot see is refused, so the heads table is never read.
    expect(reads.map((r) => r.table)).toEqual([schema.dataPlanes]);
  });
});

describe("writeLinkedHead", () => {
  const ARGS = { userId: "user_1", now: NOW };

  // #3340 finding 1: the pre-check reads the plane before the transaction,
  // so a plane that moved since would put the head where the trigger cannot
  // see it. The write asks again, uncached, under the workspace lock.
  describe("the data plane, asked again inside the transaction", () => {
    it("re-reads the organization's plane uncached, not through the cached resolver", async () => {
      armTenant([STEERING_HEAD]);
      mocks.resolveDataPlane.mockClear();
      await writeLinkedHead(SCOPE, TARGET, ARGS);
      expect(mocks.loadDataPlaneBinding).toHaveBeenCalledWith(
        "org_1",
        "postgres",
      );
      expect(mocks.resolveDataPlane).not.toHaveBeenCalled();
    });

    it("refuses with main_repo_plane_unsupported when the plane moved after the pre-check, and writes nothing", async () => {
      const tenant = armTenant([STEERING_HEAD]);
      mocks.loadDataPlaneBinding.mockResolvedValueOnce({
        orgId: "org_1",
        kind: "postgres",
        mode: "dedicated",
        status: "active",
      });
      await expect(writeLinkedHead(SCOPE, TARGET, ARGS)).rejects.toMatchObject(
        { code: "conflict", reason: "main_repo_plane_unsupported" },
      );
      // Inside the transaction, after the lock, before any read or write.
      expect(tenant.events).toEqual(["lock"]);
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });
  });

  it("takes the workspace lock, reads the heads, writes the head, then promotes the connection", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    await writeLinkedHead(SCOPE, TARGET, ARGS);
    expect(tenant.events).toEqual(["lock", "read", "write", "promote"]);
  });

  it("moves the connection to connected only while it is pending_setup", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    await writeLinkedHead(SCOPE, TARGET, ARGS);
    expect(tenant.updates).toHaveLength(1);
    const [update] = tenant.updates;
    if (!update) throw new Error("the writer updated no connection");
    expect(update.table).toBe(schema.sourceConnections);
    expect(update.values).toEqual({ status: "connected", updatedAt: NOW });
    expect(dialect.sqlToQuery(update.where).params).toEqual([
      "conn-uuid",
      "pending_setup",
    ]);
  });

  it("takes the same lock as every other writer of this workspace's heads", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    await writeLinkedHead(SCOPE, TARGET, ARGS);
    expect(tenant.locks).toHaveLength(1);
    const [lock] = tenant.locks;
    if (!lock) throw new Error("the writer took no lock");
    expect(dialect.sqlToQuery(lock)).toEqual(
      dialect.sqlToQuery(workspaceRepositoriesLock("ws_1")),
    );
    expect(dialect.sqlToQuery(lock).params).toEqual([
      "bind_main_repository:ws_1",
    ]);
  });

  it("reads this workspace's heads for this repository and its steering head", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    await writeLinkedHead(SCOPE, TARGET, ARGS);
    const [where] = tenant.reads;
    if (!where) throw new Error("the writer read no heads");
    expect(dialect.sqlToQuery(where).params).toEqual([
      "org_1",
      "ws_1",
      "github",
      "9002",
      "steering",
    ]);
  });

  it("writes a linked head on the connection and returns what the writer returned", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    const written = await writeLinkedHead(SCOPE, TARGET, ARGS);
    expect(written).toEqual({ bindingPublicId: "rpb_new" });
    expect(mocks.writeRepositoryHead.mock.calls).toEqual([
      [
        tenant.tx,
        {
          scope: SCOPE,
          connectionId: "conn-uuid",
          repo: REPO,
          role: "linked",
          userId: "user_1",
          now: NOW,
        },
      ],
    ]);
  });

  describe("refuses before it writes", () => {
    it("refuses with main_repo_unbound when the workspace has no steering head", async () => {
      armTenant([]);
      const err = await refusal(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("main_repo_unbound");
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });

    it("refuses with main_repo_unbound ahead of repository_already_linked", async () => {
      armTenant([
        { role: "linked", provider: "github", providerRepositoryId: "9002" },
      ]);
      const err = await refusal(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err.reason).toBe("main_repo_unbound");
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });

    it("refuses with main_repo when the repository is this workspace's steering repository", async () => {
      armTenant([
        { role: "steering", provider: "github", providerRepositoryId: "9002" },
      ]);
      const err = await refusal(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("main_repo");
      expect(err.message).toBe(
        "Acme/Docs is this workspace's steering repository, so it cannot also be linked",
      );
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });

    it("refuses with repository_already_linked when the workspace already links the repository", async () => {
      armTenant([
        STEERING_HEAD,
        { role: "linked", provider: "github", providerRepositoryId: "9002" },
      ]);
      const err = await refusal(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("repository_already_linked");
      expect(err.message).toBe("Acme/Docs is already linked to this workspace");
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });
  });

  it("accepts a steering repository on GitLab", async () => {
    armTenant([
      { role: "steering", provider: "gitlab", providerRepositoryId: "42" },
    ]);
    await expect(writeLinkedHead(SCOPE, TARGET, ARGS)).resolves.toEqual({
      bindingPublicId: "rpb_new",
    });
  });

  it("ignores a GitLab head that shares the GitHub repository id", async () => {
    armTenant([
      STEERING_HEAD,
      { role: "linked", provider: "gitlab", providerRepositoryId: "9002" },
    ]);
    await expect(writeLinkedHead(SCOPE, TARGET, ARGS)).resolves.toEqual({
      bindingPublicId: "rpb_new",
    });
  });

  describe("when the head write breaks a constraint", () => {
    it("maps the trigger's refusal of a linked head to main_repo_claimed", async () => {
      armTenant([STEERING_HEAD]);
      mocks.writeRepositoryHead.mockRejectedValueOnce(
        pg("repository_binding_heads_linked_is_main_elsewhere"),
      );
      const err = await refusal(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe("main_repo_claimed");
      expect(err.message).toBe(CLAIMED_MESSAGE);
    });

    it("maps the global steering index to main_repo_claimed", async () => {
      armTenant([STEERING_HEAD]);
      mocks.writeRepositoryHead.mockRejectedValueOnce(
        pg("repository_binding_heads_main_repository_uq"),
      );
      const err = await refusal(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err.reason).toBe("main_repo_claimed");
      expect(err.message).toBe(CLAIMED_MESSAGE);
    });

    it("passes an unrelated unique violation through as the same error", async () => {
      armTenant([STEERING_HEAD]);
      const violation = pg("repository_binding_heads_repository_uq");
      mocks.writeRepositoryHead.mockRejectedValueOnce(violation);
      const err = await rejection(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err).toBe(violation);
    });

    it("passes a linked_elsewhere violation through as the same error", async () => {
      armTenant([STEERING_HEAD]);
      const violation = pg("repository_binding_heads_main_is_linked_elsewhere");
      mocks.writeRepositoryHead.mockRejectedValueOnce(violation);
      const err = await rejection(writeLinkedHead(SCOPE, TARGET, ARGS));
      expect(err).toBe(violation);
    });
  });
});

describe("linkRepositoryHead", () => {
  it("writes a head with a null userId when the steering sync links the repository", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    const d = deps();
    const result = await linkRepositoryHead(
      SCOPE,
      { owner: "acme", name: "docs" },
      { userId: null, now: NOW },
      d,
    );
    expect(result).toEqual({ bindingPublicId: "rpb_new", fullName: "Acme/Docs" });
    expect(d.repository.mock.calls).toEqual([["555", "acme", "docs"]]);
    expect(mocks.writeRepositoryHead.mock.calls).toEqual([
      [
        tenant.tx,
        {
          scope: SCOPE,
          connectionId: "conn-uuid",
          repo: REPO,
          role: "linked",
          userId: null,
          now: NOW,
        },
      ],
    ]);
  });

  it("finishes the cross-workspace checks before it opens the write transaction", async () => {
    armTenant([STEERING_HEAD]);
    await linkRepositoryHead(
      SCOPE,
      { owner: "acme", name: "docs" },
      { userId: null, now: NOW },
      deps(),
    );
    const systemAt = mocks.withSystemDb.mock.invocationCallOrder.at(-1);
    const tenantAt = mocks.withTenantDb.mock.invocationCallOrder[0];
    if (systemAt === undefined || tenantAt === undefined)
      throw new Error("a database seam was not called");
    expect(systemAt).toBeLessThan(tenantAt);
  });

  it("opens no write transaction when another workspace holds the repository as its steering repository", async () => {
    armSystemDb({ steeringElsewhere: [{ id: "head-elsewhere" }] });
    const err = await refusal(
      linkRepositoryHead(
        SCOPE,
        { owner: "acme", name: "docs" },
        { userId: null, now: NOW },
        deps(),
      ),
    );
    expect(err.reason).toBe("main_repo_claimed");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });
});
