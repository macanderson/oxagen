import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoInfo } from "@oxagen/github";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { schema } from "@oxagen/database";
import { createMainRepositoryBindHandler } from "./repository.main.bind";

const CONNECTED_CONNECTION = {
  id: "conn-uuid",
  publicId: "con_ABC",
  status: "connected",
  deliveryConfig: { installationId: "555" },
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
};

/**
 * What the settings path leaves behind: `github-oauth`'s install callback
 * creates the connection with only the installation id and
 * `status = 'pending_setup'`. Nothing has named a repository yet — which is
 * exactly the state this bind is the first writer for.
 */
const PENDING_CONNECTION = {
  ...CONNECTED_CONNECTION,
  status: "pending_setup",
};

const REPO: GitHubRepoInfo = {
  id: "9001",
  owner: "Acme",
  name: "Widgets",
  fullName: "Acme/Widgets",
  htmlUrl: "https://github.com/Acme/Widgets",
  defaultBranch: "trunk",
};

/** A drizzle terminal that can be awaited, limited, or returned from. */
function rows(result: unknown[]) {
  return Object.assign(Promise.resolve(result), {
    limit: async () => result,
    returning: async () => result,
  });
}

interface Writes {
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; values: Record<string, unknown> }>;
  locks: number;
}

/**
 * The handler reads through `withTenantDb` twice: first
 * `resolveWorkspaceGithubInstallation` (select → from → where → orderBy), then
 * the bind transaction. `selects` is the queue the transaction's selects are
 * answered from, in the order the handler issues them: the workspace's binding
 * heads, then — only on an idempotent re-bind — the binding the head names.
 */
function wire(opts: {
  connections?: unknown[];
  selects?: unknown[][];
  insertReturns?: unknown[];
}): Writes {
  const writes: Writes = { inserts: [], updates: [], locks: 0 };
  const queue = [...(opts.selects ?? [[]])];
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
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async () => {
          writes.locks += 1;
          return [];
        },
        select: () => ({
          from: () => ({ where: () => rows(queue.shift() ?? []) }),
        }),
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => {
            writes.inserts.push({ table, values });
            return rows(
              opts.insertReturns ?? [
                { id: "binding-uuid", publicId: "rpb_new" },
              ],
            );
          },
        }),
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => {
            writes.updates.push({ table, values });
            return { where: () => rows([{ orgId: "org_1" }]) };
          },
        }),
      }),
    );
  return writes;
}

function handler(repository = vi.fn(async () => REPO)) {
  return {
    run: createMainRepositoryBindHandler({ repository }),
    repository,
  };
}

const INPUT = { owner: "acme", name: "widgets" };

beforeEach(() => {
  // reset, not clear: a test that refuses before the transaction leaves its
  // queued `mockImplementationOnce` behind, and `clearAllMocks` does not drain
  // that queue — the next test would then read the previous test's rows.
  vi.resetAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
});

describe("bind_main_repository", () => {
  it("refuses a caller who is not an org Owner or Admin, before reading anything", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    const { run, repository } = handler();
    await expect(run(INPUT, makeCTX())).rejects.toThrow("org_role_required");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(repository).not.toHaveBeenCalled();
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    wire({ connections: [PENDING_CONNECTION] });
    await handler().run(INPUT, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"] },
    );
  });

  it("refuses a workspace with no GitHub App installation attached", async () => {
    wire({ connections: [] });
    const { run, repository } = handler();
    await expect(run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "github_not_connected",
    });
    expect(repository).not.toHaveBeenCalled();
  });

  it("refuses a repository the installation cannot see", async () => {
    wire({ connections: [PENDING_CONNECTION] });
    const repository = vi.fn(async () => null);
    await expect(
      createMainRepositoryBindHandler({ repository })(INPUT, makeCTX()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_not_installed",
    });
    expect(repository).toHaveBeenCalledWith("555", "acme", "widgets");
  });

  it("records the bound repository where the steering seam resolves it, and marks the connection connected", async () => {
    const writes = wire({ connections: [PENDING_CONNECTION] });
    const out = await handler().run(INPUT, makeCTX());

    // The binding and its head are what `readGitHubConnection`
    // (context.steering.github.ts) joins to answer "which repository is this
    // workspace's main repo" — so the canonical owner/name GitHub reported,
    // not the caller's casing, has to land on both rows.
    const binding = writes.inserts.find(
      (w) => w.table === schema.repositoryBindings,
    );
    expect(binding?.values).toMatchObject({
      connectionId: "conn-uuid",
      provider: "github",
      providerRepositoryId: "9001",
      providerOwner: "Acme",
      providerName: "Widgets",
      providerFullName: "Acme/Widgets",
      configuredDefaultRef: "trunk",
      version: 1,
      supersedesBindingId: null,
      createdById: "u_1",
    });
    const head = writes.inserts.find(
      (w) => w.table === schema.repositoryBindingHeads,
    );
    expect(head?.values).toMatchObject({
      connectionId: "conn-uuid",
      provider: "github",
      providerRepositoryId: "9001",
      currentBindingId: "binding-uuid",
    });

    // The binding read is serialized per workspace by an advisory lock.
    expect(writes.locks).toBe(1);

    const connectionUpdate = writes.updates.find(
      (w) => w.table === schema.sourceConnections,
    );
    expect(connectionUpdate?.values).toMatchObject({ status: "connected" });

    expect(out).toMatchObject({
      bindingId: "rpb_new",
      connectionId: "con_ABC",
      fullName: "Acme/Widgets",
      defaultRef: "trunk",
      provisionalClosed: true,
    });
  });

  it("leaves an already-connected connection's status alone", async () => {
    const writes = wire({ connections: [CONNECTED_CONNECTION] });
    await handler().run(INPUT, makeCTX());
    expect(
      writes.updates.filter((w) => w.table === schema.sourceConnections),
    ).toHaveLength(0);
    expect(
      writes.updates.filter((w) => w.table === schema.onboardingState),
    ).toHaveLength(1);
  });

  it("refuses when the workspace already binds a different repository", async () => {
    const writes = wire({
      connections: [CONNECTED_CONNECTION],
      selects: [
        [{ providerRepositoryId: "4242", currentBindingId: "other-uuid" }],
      ],
    });
    await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "main_repo_bound",
    });
    expect(writes.inserts).toHaveLength(0);
  });

  it("re-binding the same repository is idempotent: no new binding, the first bind's identity", async () => {
    const boundAt = new Date("2026-09-16T08:00:00.000Z");
    const writes = wire({
      connections: [CONNECTED_CONNECTION],
      selects: [
        [{ providerRepositoryId: "9001", currentBindingId: "binding-uuid" }],
        [{ publicId: "rpb_first", createdAt: boundAt }],
      ],
    });
    const out = await handler().run(INPUT, makeCTX());
    expect(writes.inserts).toHaveLength(0);
    expect(out).toMatchObject({
      bindingId: "rpb_first",
      boundAt: boundAt.toISOString(),
    });
  });

  it("reports the provisional window already closed when nothing was open", async () => {
    mocks.withTenantDb
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: async () => [CONNECTED_CONNECTION],
              }),
            }),
          }),
        }),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => [],
          select: () => ({ from: () => ({ where: () => rows([]) }) }),
          insert: () => ({
            values: () => rows([{ id: "binding-uuid", publicId: "rpb_new" }]),
          }),
          update: () => ({
            set: () => ({ where: () => rows([]) }),
          }),
        }),
      );
    const out = await handler().run(INPUT, makeCTX());
    expect(out).toMatchObject({ provisionalClosed: false });
  });
});
