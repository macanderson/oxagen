// `link_repository` (Mission Control spec §10.1; ADR-099): a second repository
// on the workspace, as a `role = 'linked'` head. Every refusal in order — the
// role gate, no installation, an unseen repository, another workspace's main
// repository, a workspace with no main repository yet, this workspace's own
// main, an existing link, a main claim that lands elsewhere mid-flight — then
// the one write.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoInfo } from "@oxagen/github";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
  resolveDataPlane: vi.fn(
    async (): Promise<{
      orgId: string;
      kind: "postgres";
      mode: "shared" | "dedicated";
      status: "active";
    }> => ({
      orgId: "org-uuid",
      kind: "postgres",
      mode: "shared",
      status: "active",
    }),
  ),
  assertDataPlaneUsable: vi.fn(),
  writeRepositoryHead: vi.fn(
    async (
      _tx: unknown,
      _args: Record<string, unknown>,
    ): Promise<{ bindingPublicId: string }> => ({
      bindingPublicId: "rpb_0123abcd",
    }),
  ),
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
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

// The head writer has its own suite (repository.binding-write.test.ts); here
// it is a seam, so the test can say WHAT the handler asked it to write.
vi.mock("./repository.binding-write", () => ({
  writeRepositoryHead: mocks.writeRepositoryHead,
}));

import { schema } from "@oxagen/database";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { createRepositoryLinkHandler } from "./repository.link";

const CONNECTION = {
  id: "conn-uuid",
  publicId: "con_abc",
  status: "connected",
  deliveryConfig: { installationId: "555" },
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
};

const REPO: GitHubRepoInfo = {
  id: "9002",
  owner: "Acme",
  name: "Docs",
  fullName: "Acme/Docs",
  htmlUrl: "https://github.com/Acme/Docs",
  defaultBranch: "main",
};

const INPUT = { provider: "github" as const, owner: "acme", name: "docs" };

/** This workspace's main head, on a different repository than `REPO`. */
const MAIN_HEAD = { role: "main", providerRepositoryId: "1" };

interface Tx {
  locks: number;
  /** The transaction object handed to the write, for identity checks. */
  tx: unknown;
}

/** A drizzle terminal that can be awaited or `.limit()`-ed. */
function rows(result: unknown[]) {
  return Object.assign(Promise.resolve(result), {
    limit: async () => result,
  });
}

/**
 * The handler reads through `withTenantDb` twice: first
 * `resolveWorkspaceGithubInstallation` (select → from → where → orderBy), then
 * the link transaction, whose one select is this workspace's main head plus
 * its heads for the repository. `heads` answers that select as one list.
 */
function wire(opts: { connections?: unknown[]; heads?: unknown[] }): Tx {
  const state: Tx = { locks: 0, tx: null };
  mocks.withTenantDb
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: async () => opts.connections ?? [] }),
          }),
        }),
      }),
    )
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: async () => {
          state.locks += 1;
          return [];
        },
        select: () => ({
          from: () => ({ where: () => rows(opts.heads ?? []) }),
        }),
      };
      state.tx = tx;
      return fn(tx);
    });
  return state;
}

/**
 * The two shared-plane reads, told apart by table: is any organisation on a
 * dedicated plane (then the global claim is unknowable), and does another
 * workspace hold this repository as its MAIN.
 */
function sharedPlane(opts: {
  mainElsewhere?: unknown[];
  dedicated?: unknown[];
}) {
  const byTable = new Map<unknown, unknown[]>([
    [schema.repositoryBindingHeads, opts.mainElsewhere ?? []],
    [schema.dataPlanes, opts.dedicated ?? []],
  ]);
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({ limit: async () => byTable.get(table) ?? [] }),
          }),
        }),
      }),
  );
}

function handler(repository = vi.fn(async () => REPO)) {
  return { run: createRepositoryLinkHandler({ repository }), repository };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
  mocks.resolveDataPlane.mockResolvedValue({
    orgId: "org-uuid",
    kind: "postgres",
    mode: "shared",
    status: "active",
  });
  mocks.writeRepositoryHead.mockResolvedValue({
    bindingPublicId: "rpb_0123abcd",
  });
  sharedPlane({});
});

describe("link_repository", () => {
  it("refuses a caller who is not an org Owner/Admin or the workspace Owner, before reading anything", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    const { run, repository } = handler();
    await expect(run(INPUT, makeCTX())).rejects.toThrow("org_role_required");
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(repository).not.toHaveBeenCalled();
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  it("refuses a workspace with no GitHub App installation attached", async () => {
    wire({ connections: [] });
    const { run, repository } = handler();
    await expect(run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "github_not_connected",
    });
    expect(repository).not.toHaveBeenCalled();
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  it("refuses a repository the installation cannot see", async () => {
    wire({ connections: [CONNECTION] });
    const repository = vi.fn(async () => null);
    await expect(
      createRepositoryLinkHandler({ repository })(INPUT, makeCTX()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_not_installed",
    });
    // Through the connection's installation, never one the caller named.
    expect(repository).toHaveBeenCalledWith("555", "acme", "docs");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  it("refuses a repository that is ANOTHER workspace's main repository, naming neither holder, before the transaction", async () => {
    sharedPlane({ mainElsewhere: [{ id: "head-elsewhere" }] });
    const state = wire({ connections: [CONNECTION] });
    const err = await handler()
      .run(INPUT, makeCTX())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({
      code: "conflict",
      reason: "main_repo_claimed",
    });
    expect((err as Error).message).toContain("Acme/Docs");
    expect((err as Error).message).not.toContain("head-elsewhere");
    // Refused before the link transaction: no lock, no write.
    expect(state.locks).toBe(0);
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  it("refuses while any organisation is on a dedicated Postgres plane, where the claim is unknowable", async () => {
    sharedPlane({ dedicated: [{ id: "dpl_other" }] });
    wire({ connections: [CONNECTION] });
    await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "main_repo_plane_unsupported",
    });
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  // The organisation's first workspace is written without a main repository
  // (ADR-099 §6), and GitHub can be attached to it before `bind_main_repository`
  // runs. A link then would be a linked head with no main beside it.
  it("refuses a workspace with no main repository yet with main_repo_unbound, inside the lock", async () => {
    const state = wire({ connections: [CONNECTION], heads: [] });
    const err = await handler()
      .run(INPUT, makeCTX())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({
      code: "conflict",
      reason: "main_repo_unbound",
    });
    expect((err as Error).message).toBe(
      "Bind this workspace's main repository first; a linked repository is its second.",
    );
    expect(state.locks).toBe(1);
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  it("main_repo_unbound wins over an existing link of the same repository: a head the demotion left behind does not stand in for a main", async () => {
    wire({
      connections: [CONNECTION],
      heads: [{ role: "linked", providerRepositoryId: "9002" }],
    });
    await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "main_repo_unbound",
    });
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  it("refuses this workspace's own main repository with main_repo, inside the lock", async () => {
    const state = wire({
      connections: [CONNECTION],
      heads: [{ role: "main", providerRepositoryId: "9002" }],
    });
    await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "main_repo",
    });
    expect(state.locks).toBe(1);
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  it("refuses a repository already linked to this workspace", async () => {
    const state = wire({
      connections: [CONNECTION],
      heads: [MAIN_HEAD, { role: "linked", providerRepositoryId: "9002" }],
    });
    await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "repository_already_linked",
    });
    expect(state.locks).toBe(1);
    expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
  });

  // The window the pre-check cannot close: a main claim on this repository
  // committed elsewhere after the read. The trigger's repository-keyed lock
  // serialised the two writes and refused this one by constraint name.
  it("refuses with main_repo_claimed when the trigger refuses the linked head because a main head landed elsewhere mid-flight", async () => {
    wire({ connections: [CONNECTION], heads: [MAIN_HEAD] });
    mocks.writeRepositoryHead.mockRejectedValueOnce(
      Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("trigger refused"), {
          code: "23505",
          constraint_name: "repository_binding_heads_linked_is_main_elsewhere",
        }),
      }),
    );
    const err = await handler()
      .run(INPUT, makeCTX())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({
      code: "conflict",
      reason: "main_repo_claimed",
    });
    expect((err as Error).message).toContain("Acme/Docs");
  });

  it("lets an unrelated unique violation through as itself", async () => {
    wire({ connections: [CONNECTION], heads: [MAIN_HEAD] });
    const unrelated = Object.assign(new Error("insert failed"), {
      cause: Object.assign(new Error("duplicate key value"), {
        code: "23505",
        constraint_name: "repository_binding_heads_repository_uq",
      }),
    });
    mocks.writeRepositoryHead.mockRejectedValueOnce(unrelated);
    const err = await handler()
      .run(INPUT, makeCTX())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBe(unrelated);
  });

  it("writes a linked head through writeRepositoryHead, on the locked transaction, and answers the contract's shape", async () => {
    const state = wire({ connections: [CONNECTION], heads: [MAIN_HEAD] });
    const before = Date.now();
    const out = await handler().run(INPUT, makeCTX());

    expect(state.locks).toBe(1);
    expect(mocks.writeRepositoryHead).toHaveBeenCalledTimes(1);
    const [tx, args] = mocks.writeRepositoryHead.mock.calls[0]!;
    // The same transaction that took the workspace lock and read the heads.
    expect(tx).toBe(state.tx);
    expect(args).toMatchObject({
      scope: { orgId: "org_1", workspaceId: "ws_1" },
      connectionId: "conn-uuid",
      repo: REPO,
      role: "linked",
      userId: "u_1",
      now: expect.any(Date),
    });

    expect(out).toEqual({
      bindingId: "rpb_0123abcd",
      connectionId: "con_abc",
      fullName: "Acme/Docs",
      defaultRef: "main",
      role: "linked",
      linkedAt: (args["now"] as Date).toISOString(),
    });
    expect(Date.parse(out.linkedAt)).toBeGreaterThanOrEqual(before);
    // What the kernel will parse on the way out.
    expect(repositoryLink.output.safeParse(out).success).toBe(true);
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    wire({ connections: [CONNECTION], heads: [MAIN_HEAD] });
    await handler().run(INPUT, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    // And the head is attributed to that user, not the session's.
    expect(mocks.writeRepositoryHead.mock.calls[0]?.[1]).toMatchObject({
      userId: "u_acting",
    });
  });
});
