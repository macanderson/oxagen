// repository.link.write.ts is the one writer of a linked head (ADR-212).
// `link_repository` runs its checks before it opens a steering PR, and the
// steering sync runs the checks and the write once that steering PR merges.
//
// The database is a fake. `withTenantDb` hands over a transaction that
// records the lock, the heads read and the write in the order they happen.
// `withSystemDb` throws when called: a link reads no other tenant's rows
// (ADR-293). The installation resolver and the head writer are seams, so each
// case names what reached them.
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
  // Widened so a test can put the organization on a dedicated plane. A link
  // reads no plane since ADR-293, so the tests assert neither read is made.
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
  // The uncached plane read the write transaction made before ADR-293.
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

/** The organization on a dedicated Postgres plane (ADR-042). */
const DEDICATED = {
  orgId: "org_1",
  kind: "postgres",
  mode: "dedicated",
  status: "active",
} as const;

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

/**
 * A link reads no other tenant's rows (ADR-293), so the cross-tenant seam
 * throws. A test that reaches it fails on the error, and each test also
 * asserts the seam was never called.
 */
function forbidSystemDb(): void {
  mocks.withSystemDb.mockImplementation(async () => {
    throw new Error("a link read another tenant's rows through withSystemDb");
  });
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
  forbidSystemDb();
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
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  // ADR-293: another workspace's heads never refuse a link. Before it, a
  // repository another workspace steered by was refused as main_repo_claimed
  // after a cross-tenant read of the heads.
  it("accepts a repository another workspace steers by, and reads no other workspace's heads", async () => {
    const d = deps();
    await expect(resolveLinkTarget(SCOPE, "acme", "docs", d)).resolves.toEqual(
      TARGET,
    );
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("accepts a repository when the organization is on a dedicated data plane, and reads no plane", async () => {
    mocks.resolveDataPlane.mockResolvedValue(DEDICATED);
    await expect(
      resolveLinkTarget(SCOPE, "acme", "docs", deps()),
    ).resolves.toEqual(TARGET);
    expect(mocks.resolveDataPlane).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

describe("writeLinkedHead", () => {
  const ARGS = { userId: "user_1", now: NOW };

  // #3340 finding 1 re-read the plane inside the transaction, because a head
  // on a dedicated plane escaped the cross-workspace trigger. ADR-293 dropped
  // that trigger, so a link writes on any plane and asks no plane at all.
  it("writes the head when the organization is on a dedicated data plane, and reads no plane", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    mocks.loadDataPlaneBinding.mockResolvedValue(DEDICATED);
    await expect(writeLinkedHead(SCOPE, TARGET, ARGS)).resolves.toEqual({
      bindingPublicId: "rpb_new",
    });
    expect(tenant.events).toEqual(["lock", "read", "write", "promote"]);
    expect(mocks.loadDataPlaneBinding).not.toHaveBeenCalled();
    expect(mocks.resolveDataPlane).not.toHaveBeenCalled();
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

  // A linked head is outside every cross-workspace constraint (ADR-293), so
  // the writer maps no unique violation to a refusal of its own.
  describe("when the head write breaks a constraint", () => {
    it.each([
      "repository_binding_heads_repository_uq",
      "repository_binding_heads_main_repository_uq",
    ])("passes a %s violation through as the same error", async (name) => {
      armTenant([STEERING_HEAD]);
      const violation = pg(name);
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

  // ADR-293: the steering sync links a repository another workspace steers
  // by, the same as any other. Only this workspace's heads are read.
  it("links a repository another workspace steers by, reading only this workspace's heads", async () => {
    const tenant = armTenant([STEERING_HEAD]);
    await expect(
      linkRepositoryHead(
        SCOPE,
        { owner: "acme", name: "docs" },
        { userId: null, now: NOW },
        deps(),
      ),
    ).resolves.toEqual({ bindingPublicId: "rpb_new", fullName: "Acme/Docs" });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(tenant.events).toEqual(["lock", "read", "write", "promote"]);
    const [where] = tenant.reads;
    if (!where) throw new Error("the writer read no heads");
    // org and workspace first: the read is this workspace's alone.
    expect(dialect.sqlToQuery(where).params.slice(0, 2)).toEqual([
      "org_1",
      "ws_1",
    ]);
  });

  it.each<[string, HeadRow[], string]>([
    [
      "its own steering repository",
      [{ role: "steering", provider: "github", providerRepositoryId: "9002" }],
      "main_repo",
    ],
    [
      "a repository it already links",
      [
        STEERING_HEAD,
        { role: "linked", provider: "github", providerRepositoryId: "9002" },
      ],
      "repository_already_linked",
    ],
  ])(
    "still refuses %s and writes nothing (negative)",
    async (_name, heads, reason) => {
      armTenant(heads);
      const err = await refusal(
        linkRepositoryHead(
          SCOPE,
          { owner: "acme", name: "docs" },
          { userId: null, now: NOW },
          deps(),
        ),
      );
      expect(err.code).toBe("conflict");
      expect(err.reason).toBe(reason);
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
      expect(mocks.withSystemDb).not.toHaveBeenCalled();
    },
  );
});
