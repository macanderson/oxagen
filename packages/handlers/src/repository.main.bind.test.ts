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
 * heads, then — whenever a head already names this repository — the binding
 * that head points at.
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
        [
          {
            id: "head-uuid",
            connectionId: "conn-uuid",
            providerRepositoryId: "4242",
            currentBindingId: "other-uuid",
          },
        ],
      ],
    });
    await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "main_repo_bound",
    });
    expect(writes.inserts).toHaveLength(0);
  });

  it("re-binding the same repository through the same connection is idempotent: no new binding, the first bind's identity", async () => {
    const boundAt = new Date("2026-09-16T08:00:00.000Z");
    const writes = wire({
      connections: [CONNECTED_CONNECTION],
      selects: [
        [
          {
            id: "head-uuid",
            // The head already names the connection the bind resolved, so
            // nothing has moved and nothing is written.
            connectionId: "conn-uuid",
            providerRepositoryId: "9001",
            currentBindingId: "binding-uuid",
          },
        ],
        [
          {
            id: "binding-uuid",
            publicId: "rpb_first",
            createdAt: boundAt,
            version: 1,
            // Every fact the binding records still matches what GitHub reports,
            // which is what makes this idempotent. Drift in any one of them is
            // a re-approval and writes a successor — see the tests below.
            connectionId: "conn-uuid",
            providerOwner: REPO.owner,
            providerName: REPO.name,
            providerFullName: REPO.fullName,
            configuredDefaultRef: REPO.defaultBranch,
          },
        ],
      ],
    });
    const out = await handler().run(INPUT, makeCTX());
    expect(writes.inserts).toHaveLength(0);
    expect(
      writes.updates.filter((w) => w.table === schema.repositoryBindingHeads),
    ).toHaveLength(0);
    expect(out).toMatchObject({
      bindingId: "rpb_first",
      boundAt: boundAt.toISOString(),
    });
  });

  /**
   * The repair, and the state that needs it (#3233).
   *
   * Delete the workspace's GitHub connection and reconnect: `delete_connection`
   * leaves the old row at `status = 'deleting'` for a later purge, so
   * `attachWorkspaceGithubInstallation` — which reads live rows only — inserts a
   * NEW connection, and the binding head goes on naming the retired one. Every
   * reader that joins the head back to its connection (`readGitHubConnection`,
   * the seam steering resolves the main repository through) then finds nothing,
   * so steering is off while the workspace still reads as bound. Before this,
   * re-binding the same repository took the idempotent branch and moved nothing,
   * so there was no way back from any surface.
   */
  describe("re-binding the same repository through a replacement connection", () => {
    const RETIRED_HEAD = {
      id: "head-uuid",
      // The connection this workspace acted through before the delete.
      connectionId: "retired-conn-uuid",
      providerRepositoryId: "9001",
      currentBindingId: "binding-1",
    };
    const CURRENT_BINDING = {
      id: "binding-1",
      publicId: "rpb_first",
      createdAt: new Date("2026-09-16T08:00:00.000Z"),
      version: 3,
      // The repository's own facts are unchanged; only the connection moved.
      // Stated explicitly so these tests keep proving the CONNECTION repair
      // rather than passing on incidental drift in some other field.
      connectionId: "retired-conn-uuid",
      providerOwner: REPO.owner,
      providerName: REPO.name,
      providerFullName: REPO.fullName,
      configuredDefaultRef: REPO.defaultBranch,
    };

    function repair() {
      return wire({
        connections: [CONNECTED_CONNECTION],
        selects: [[RETIRED_HEAD], [CURRENT_BINDING]],
        insertReturns: [{ id: "binding-2", publicId: "rpb_second" }],
      });
    }

    it("supersedes the binding onto the live connection, keeping the version chain", async () => {
      const writes = repair();
      const out = await handler().run(INPUT, makeCTX());

      const binding = writes.inserts.find(
        (w) => w.table === schema.repositoryBindings,
      );
      expect(binding?.values).toMatchObject({
        connectionId: "conn-uuid",
        // version + 1 and a parent, which is exactly what
        // repository_bindings_supersedes_check admits for a version past 1.
        version: 4,
        supersedesBindingId: "binding-1",
        // Freshly observed identity, as GitHub reported it on this call.
        providerRepositoryId: "9001",
        providerOwner: "Acme",
        providerName: "Widgets",
        providerFullName: "Acme/Widgets",
        configuredDefaultRef: "trunk",
        createdById: "u_1",
      });
      expect(out).toMatchObject({
        bindingId: "rpb_second",
        connectionId: "con_ABC",
        fullName: "Acme/Widgets",
      });
    });

    it("moves the head onto the live connection and its new binding, in place", async () => {
      const writes = repair();
      await handler().run(INPUT, makeCTX());

      // Updated, never inserted: a second head row would leave two heads for one
      // workspace repository, and whichever a reader took would disagree with
      // the binding about the connection.
      expect(
        writes.inserts.filter((w) => w.table === schema.repositoryBindingHeads),
      ).toHaveLength(0);
      const head = writes.updates.find(
        (w) => w.table === schema.repositoryBindingHeads,
      );
      expect(head?.values).toMatchObject({
        connectionId: "conn-uuid",
        currentBindingId: "binding-2",
        updatedAt: expect.any(Date),
      });
    });

    it("leaves the superseded binding row exactly as it was", async () => {
      const writes = repair();
      await handler().run(INPUT, makeCTX());
      // A binding is immutable evidence; only the head pointer moves.
      expect(
        writes.updates.filter((w) => w.table === schema.repositoryBindings),
      ).toHaveLength(0);
      expect(
        writes.inserts.filter((w) => w.table === schema.repositoryBindings),
      ).toHaveLength(1);
    });

    it("answers the new binding's identity, not the superseded one's", async () => {
      repair();
      const out = await handler().run(INPUT, makeCTX());
      expect(out.bindingId).toBe("rpb_second");
      expect(out.boundAt).not.toBe(CURRENT_BINDING.createdAt.toISOString());
    });

    it("still refuses a DIFFERENT repository through the replacement connection (negative)", async () => {
      // The repair is of the connection behind the same repository. Moving a
      // workspace to another repository stays an org owner's decision recorded
      // as a security event (spec §10.1), whichever connection asks.
      const writes = wire({
        connections: [CONNECTED_CONNECTION],
        selects: [[{ ...RETIRED_HEAD, providerRepositoryId: "4242" }]],
      });
      await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
        code: "conflict",
        reason: "main_repo_bound",
      });
      expect(writes.inserts).toHaveLength(0);
      expect(writes.updates).toHaveLength(0);
    });
  });

  /**
   * The other repair, and the state that needs it (#3265 review, P1).
   *
   * Steering resolves `defaultBranch` from the binding's `configuredDefaultRef`
   * and `assertProductionBase` refuses any Context PR whose base is not it — so
   * once GitHub's default branch is renamed, a workspace whose binding still
   * names the old one can open and merge nothing. Before this, re-binding the
   * same repository through the same connection took the idempotent branch,
   * compared only the connection, and wrote nothing: the one repair the UI
   * offers did not repair it, and `set_main_repository` is a spec entry with no
   * contract and no handler. The ref had no way to change from any surface.
   *
   * A binding version is defined by the table's own header as "a rename or a
   * reconfigured default ref", so this is the case the version chain exists for.
   */
  describe("re-binding the same repository after its recorded facts moved", () => {
    const HEAD = {
      id: "head-uuid",
      connectionId: "conn-uuid",
      providerRepositoryId: "9001",
      currentBindingId: "binding-1",
    };
    /** Bound when `main` was the default; GitHub now reports `trunk`. */
    const STALE_REF_BINDING = {
      id: "binding-1",
      publicId: "rpb_first",
      createdAt: new Date("2026-09-16T08:00:00.000Z"),
      version: 1,
      connectionId: "conn-uuid",
      providerOwner: REPO.owner,
      providerName: REPO.name,
      providerFullName: REPO.fullName,
      configuredDefaultRef: "main",
    };

    function rebind(binding: Record<string, unknown>) {
      return wire({
        connections: [CONNECTED_CONNECTION],
        selects: [[HEAD], [binding]],
        insertReturns: [{ id: "binding-2", publicId: "rpb_second" }],
      });
    }

    it("approves the new default branch by superseding the binding, so steering is unstuck", async () => {
      const writes = rebind(STALE_REF_BINDING);
      const out = await handler().run(INPUT, makeCTX());

      const binding = writes.inserts.find(
        (w) => w.table === schema.repositoryBindings,
      );
      // The successor carries the ref GitHub reports NOW. This is the only way
      // the approved ref ever changes: a deliberate operator re-bind, never
      // live GitHub state read at steering time — which is the invariant
      // `resolveRepository` was fixed to hold.
      expect(binding?.values).toMatchObject({
        configuredDefaultRef: "trunk",
        version: 2,
        supersedesBindingId: "binding-1",
        connectionId: "conn-uuid",
        createdById: "u_1",
      });
      expect(out).toMatchObject({ bindingId: "rpb_second" });
    });

    it("moves the head onto the successor so readers resolve the approved ref", async () => {
      const writes = rebind(STALE_REF_BINDING);
      await handler().run(INPUT, makeCTX());

      // Without this the successor exists and nothing reads it: `readGitHub-
      // Connection` resolves through the head, so a head left on the stale
      // binding would leave steering exactly as stuck as before.
      const head = writes.updates.find(
        (w) => w.table === schema.repositoryBindingHeads,
      );
      expect(head?.values).toMatchObject({ currentBindingId: "binding-2" });
      expect(
        writes.updates.filter((w) => w.table === schema.repositoryBindings),
      ).toHaveLength(0);
    });

    it("supersedes on a repository rename too, carrying every renamed field together", async () => {
      // `fullName` is dotted into the `set_id` of every Context record file and
      // `owner`/`name` address every GitHub call, so a rename that updated only
      // some of them would put the binding in a state no observation produced.
      const writes = rebind({
        ...STALE_REF_BINDING,
        configuredDefaultRef: REPO.defaultBranch,
        providerOwner: "OldOrg",
        providerName: "OldName",
        providerFullName: "OldOrg/OldName",
      });
      await handler().run(INPUT, makeCTX());

      const binding = writes.inserts.find(
        (w) => w.table === schema.repositoryBindings,
      );
      expect(binding?.values).toMatchObject({
        providerOwner: "Acme",
        providerName: "Widgets",
        providerFullName: "Acme/Widgets",
        configuredDefaultRef: "trunk",
        version: 2,
        supersedesBindingId: "binding-1",
      });
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
