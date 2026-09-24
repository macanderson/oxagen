import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoInfo } from "@oxagen/github";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
  // Widened deliberately: a test overrides `mode` to "dedicated" to cover the
  // ADR-042 refusal, and inferring the literal "shared" from the default would
  // make that override a type error.
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
  // The UNCACHED read the write transaction re-validates with. Separate from
  // `resolveDataPlane` on purpose: the resolver caches per process, so a test
  // that moved only the cached answer would prove nothing about the re-ask.
  loadDataPlaneBinding: vi.fn(
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
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { schema } from "@oxagen/database";
import {
  createMainRepositoryBindHandler,
  repositoryHeadConflict,
} from "./repository.main.bind";

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

/**
 * A drizzle terminal that can be awaited, limited, ordered or returned from.
 * `orderBy` answers itself, so `writeRepositoryHead`'s
 * `.orderBy(desc(version)).limit(1)` reads the same queued rows.
 */
function rows(result: unknown[]) {
  const terminal: Promise<unknown[]> & {
    limit: () => Promise<unknown[]>;
    returning: () => Promise<unknown[]>;
    orderBy: () => typeof terminal;
  } = Object.assign(Promise.resolve(result), {
    limit: async () => result,
    returning: async () => result,
    orderBy: () => terminal,
  });
  return terminal;
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
  // Shared plane, and no other workspace claims this repository, unless the
  // test says otherwise. `resetAllMocks` drops these, so they are re-armed
  // here rather than only at the `vi.hoisted` definition.
  mocks.resolveDataPlane.mockResolvedValue({
    orgId: "org-uuid",
    kind: "postgres",
    mode: "shared",
    status: "active",
  });
  mocks.loadDataPlaneBinding.mockResolvedValue({
    orgId: "org-uuid",
    kind: "postgres",
    mode: "shared",
    status: "active",
  });
  claimedElsewhere([]);
});

/** Rows the shared-plane reads return, keyed by the table each one names. */
let sharedRows = new Map<unknown, unknown[]>();

/**
 * Arm the two reads the handler makes on the shared plane. They must be told
 * apart by the table they select from: one asks whether ANY organisation is on
 * a dedicated Postgres plane (if so the global claim is unknowable and the
 * bind is refused), the other asks whether another workspace already holds a
 * head, main or linked, for this repository. A mock that answered both with
 * one value made a claim row look like a dedicated plane and produced the
 * wrong refusal.
 */
function sharedPlaneReads(byTable: Map<unknown, unknown[]>): void {
  sharedRows = byTable;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: (table: unknown) => ({
            where: () => rows(sharedRows.get(table) ?? []),
          }),
        }),
      }),
  );
}

/**
 * What the cross-tenant exclusivity read finds. `[]` is "nobody else holds
 * this repository"; a row is another workspace's head on it, with its role.
 * No organisation is on a dedicated plane unless a test says so.
 */
function claimedElsewhere(result: unknown[]): void {
  sharedPlaneReads(
    new Map<unknown, unknown[]>([
      [schema.repositoryBindingHeads, result],
      [schema.dataPlanes, []],
    ]),
  );
}

/** Some organisation — not necessarily this one — is on a dedicated plane. */
function dedicatedPlaneExists(): void {
  sharedPlaneReads(
    new Map<unknown, unknown[]>([
      [schema.repositoryBindingHeads, []],
      [schema.dataPlanes, [{ id: "dpl_other" }]],
    ]),
  );
}

describe("repositoryHeadConflict", () => {
  const pg = (constraint_name: string, code = "23505") =>
    Object.assign(new Error("insert failed"), {
      cause: Object.assign(new Error("refused"), { code, constraint_name }),
    });

  it("maps the index and the trigger's three constraint names by what they mean", () => {
    expect(
      repositoryHeadConflict(pg("repository_binding_heads_main_repository_uq")),
    ).toBe("main_elsewhere");
    expect(
      repositoryHeadConflict(
        pg("repository_binding_heads_linked_is_main_elsewhere"),
      ),
    ).toBe("main_elsewhere");
    expect(
      repositoryHeadConflict(
        pg("repository_binding_heads_main_is_linked_elsewhere"),
      ),
    ).toBe("linked_elsewhere");
  });

  it("answers null for another constraint, another code, a plain error and nothing", () => {
    expect(
      repositoryHeadConflict(pg("repository_binding_heads_repository_uq")),
    ).toBeNull();
    expect(
      repositoryHeadConflict(
        pg("repository_binding_heads_main_repository_uq", "23503"),
      ),
    ).toBeNull();
    expect(repositoryHeadConflict(new Error("boom"))).toBeNull();
    expect(repositoryHeadConflict(null)).toBeNull();
  });

  it("finds the constraint nested under `cause` and stops after five hops", () => {
    let deep: unknown = Object.assign(new Error("leaf"), {
      code: "23505",
      constraint_name: "repository_binding_heads_main_repository_uq",
    });
    for (let i = 0; i < 6; i++)
      deep = Object.assign(new Error(`wrap ${i}`), { cause: deep });
    expect(repositoryHeadConflict(deep)).toBeNull();
  });
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
            role: "main",
            provider: "github",
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
            role: "main",
            provider: "github",
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
      role: "main",
      provider: "github",
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
      role: "main",
      provider: "github",
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

  // ── A head this workspace already holds as LINKED ──────────────────────────
  // `link_repository` refuses a link while the workspace has no main
  // repository, but the exclusivity migration's own demotion leaves exactly
  // that state: a head it turned from main into linked, in a workspace with no
  // main head left. Binding a repository from there has to promote the head it
  // finds. A second head for one (connection, repository) is refused by
  // `repository_binding_heads_repository_uq` and a second version-1 binding by
  // `repository_bindings_repository_version_uq`; neither is a cross-workspace
  // claim, so `rethrowHeadConflict` passes them through and the operator used
  // to get a 500 on the one move that would give the workspace a main
  // repository back.
  describe("binding a repository this workspace holds as a linked head", () => {
    const LINKED_HEAD = {
      id: "head-uuid",
      role: "linked",
      provider: "github",
      connectionId: "conn-uuid",
      providerRepositoryId: "9001",
      currentBindingId: "binding-1",
    };
    /** Its binding, recording exactly what GitHub still reports. */
    const UNCHANGED_BINDING = {
      id: "binding-1",
      publicId: "rpb_first",
      createdAt: new Date("2026-09-16T08:00:00.000Z"),
      version: 1,
      connectionId: "conn-uuid",
      providerOwner: REPO.owner,
      providerName: REPO.name,
      providerFullName: REPO.fullName,
      configuredDefaultRef: REPO.defaultBranch,
    };

    it("promotes the head in place instead of writing a second head or a second version-1 binding", async () => {
      const writes = wire({
        connections: [CONNECTED_CONNECTION],
        selects: [[LINKED_HEAD], [UNCHANGED_BINDING]],
      });
      const out = await handler().run(INPUT, makeCTX());

      expect(writes.inserts).toHaveLength(0);
      const headUpdate = writes.updates.find(
        (w) => w.table === schema.repositoryBindingHeads,
      );
      expect(headUpdate?.values).toMatchObject({ role: "main" });
      // The binding records nothing new, so the retained version answers.
      expect(out.bindingId).toBe("rpb_first");
      // `boundAt` is the promotion, not the original link: now is when this
      // repository became the one steering the workspace.
      expect(Date.parse(out.boundAt)).toBeGreaterThan(
        UNCHANGED_BINDING.createdAt.getTime(),
      );
    });

    it("still refuses a different repository while a main head sits beside the linked one", async () => {
      const writes = wire({
        connections: [CONNECTED_CONNECTION],
        selects: [
          [
            {
              id: "other-head",
              role: "main",
              provider: "github",
              connectionId: "conn-uuid",
              providerRepositoryId: "4242",
              currentBindingId: "other-binding",
            },
            { ...LINKED_HEAD, providerRepositoryId: "7777" },
          ],
        ],
      });
      await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
        code: "conflict",
        reason: "main_repo_bound",
      });
      expect(writes.inserts).toHaveLength(0);
      expect(writes.updates).toHaveLength(0);
    });

    it("reuses a binding version retained from an unlinked head rather than writing version 1 again", async () => {
      // The head was removed by `unlink_repository`; its binding versions stay,
      // because admitted runs cite them.
      const writes = wire({
        connections: [CONNECTED_CONNECTION],
        selects: [[], [UNCHANGED_BINDING]],
      });
      const out = await handler().run(INPUT, makeCTX());

      expect(
        writes.inserts.filter((w) => w.table === schema.repositoryBindings),
      ).toHaveLength(0);
      const head = writes.inserts.find(
        (w) => w.table === schema.repositoryBindingHeads,
      );
      expect(head?.values).toMatchObject({
        role: "main",
        provider: "github",
        currentBindingId: "binding-1",
      });
      expect(out.bindingId).toBe("rpb_first");
    });
  });

  // ── One repository steers exactly one workspace, anywhere ──────────────────
  // `.oxagen/rules/` lives in the main repository and is keyed by the
  // repository's full name, so two workspaces sharing one would write the same
  // rule set into the same files and read each other's records back as their
  // own. The guarantee is the partial unique index; these cover the handler's
  // two jobs around it — refusing with a sentence, and never leaking whose
  // claim it collided with.
  describe("a repository already steering another workspace", () => {
    it("is refused, and the refusal names neither the org nor the workspace holding it", async () => {
      claimedElsewhere([
        { role: "main", workspaceId: "someone-elses-workspace" },
      ]);
      const writes = wire({ connections: [CONNECTED_CONNECTION] });

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
      const message = (err as Error).message;
      expect(message).toContain("Acme/Widgets");
      // The index is global, so this fires across tenants. Naming the holder
      // would report one customer's existence and repository choices to
      // another.
      expect(message).not.toContain("someone-elses-workspace");
      // Refused before the transaction: nothing is written, and the advisory
      // lock is never even taken.
      expect(writes.inserts).toHaveLength(0);
      expect(writes.locks).toBe(0);
    });

    // A repository another workspace has LINKED cannot become this one's main
    // either: a main repository holds the `.oxagen/` governance tree, and a
    // linked one receives another workspace's Context PRs.
    it("is refused as repository_linked_elsewhere when another workspace has linked it, naming neither holder", async () => {
      claimedElsewhere([
        { role: "linked", workspaceId: "someone-elses-workspace" },
      ]);
      const writes = wire({ connections: [CONNECTED_CONNECTION] });
      const err = await handler()
        .run(INPUT, makeCTX())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({
        code: "conflict",
        reason: "repository_linked_elsewhere",
      });
      const message = (err as Error).message;
      expect(message).toContain("Acme/Widgets");
      expect(message).not.toContain("someone-elses-workspace");
      expect(writes.inserts).toHaveLength(0);
      expect(writes.locks).toBe(0);
    });

    it("a main head elsewhere wins the sentence over a linked one, as the trigger orders them", async () => {
      claimedElsewhere([
        { role: "linked", workspaceId: "ws-linked" },
        { role: "main", workspaceId: "ws-main" },
      ]);
      wire({ connections: [CONNECTED_CONNECTION] });
      await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
        reason: "main_repo_claimed",
      });
    });

    it("refuses as repository_linked_elsewhere when the trigger refuses the main head because a link landed elsewhere mid-flight", async () => {
      claimedElsewhere([]);
      wire({ connections: [CONNECTED_CONNECTION] });
      const violation = Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("trigger refused"), {
          code: "23505",
          constraint_name: "repository_binding_heads_main_is_linked_elsewhere",
        }),
      });
      mocks.withTenantDb.mockReset();
      mocks.withTenantDb
        .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            select: () => ({
              from: () => ({
                where: () => ({ orderBy: async () => [CONNECTED_CONNECTION] }),
              }),
            }),
          }),
        )
        .mockImplementationOnce(async () => {
          throw violation;
        });
      await expect(handler().run(INPUT, makeCTX())).rejects.toMatchObject({
        code: "conflict",
        reason: "repository_linked_elsewhere",
      });
    });

    it("refuses with the same conflict when the claim lands mid-flight, rather than surfacing a raw constraint violation", async () => {
      // The window the pre-check cannot close: both binds read no claim, and
      // the loser meets the unique index inside its transaction. The advisory
      // lock does not serialise them — it is keyed on the workspace.
      claimedElsewhere([]);
      wire({ connections: [CONNECTED_CONNECTION] });
      const violation = Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint_name: "repository_binding_heads_main_repository_uq",
        }),
      });
      mocks.withTenantDb.mockReset();
      mocks.withTenantDb
        .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            select: () => ({
              from: () => ({
                where: () => ({ orderBy: async () => [CONNECTED_CONNECTION] }),
              }),
            }),
          }),
        )
        .mockImplementationOnce(async () => {
          throw violation;
        });

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
    });

    it("lets an unrelated unique violation through as itself", async () => {
      // Matching on 23505 alone would report a collision on
      // `repository_binding_heads_repository_uq` — a different fault entirely —
      // as "claimed by another workspace", sending the operator to look for a
      // workspace that does not exist.
      claimedElsewhere([]);
      wire({ connections: [CONNECTED_CONNECTION] });
      const unrelated = Object.assign(new Error("insert failed"), {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint_name: "repository_binding_heads_repository_uq",
        }),
      });
      mocks.withTenantDb.mockReset();
      mocks.withTenantDb
        .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            select: () => ({
              from: () => ({
                where: () => ({ orderBy: async () => [CONNECTED_CONNECTION] }),
              }),
            }),
          }),
        )
        .mockImplementationOnce(async () => {
          throw unrelated;
        });

      const err = await handler()
        .run(INPUT, makeCTX())
        .then(
          () => null,
          (e: unknown) => e,
        );
      // The SAME object, not merely one whose message matches. A future broad
      // 23505 mapping would still throw something saying "insert failed", so
      // identity is what pins the propagation, and the absence of the reason
      // is what pins that it was not reclassified.
      expect(err).toBe(unrelated);
      expect(err).not.toMatchObject({ reason: "main_repo_claimed" });
    });

    // The pre-check that produces the ordinary refusal cannot see a head held
    // on a plane it does not open, so a dedicated plane ANYWHERE — not only
    // this organisation's — makes the global claim unknowable.
    it("refuses while any organisation is on a dedicated Postgres plane", async () => {
      dedicatedPlaneExists();
      const writes = wire({ connections: [CONNECTED_CONNECTION] });

      const err = await handler()
        .run(INPUT, makeCTX())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({
        code: "conflict",
        reason: "main_repo_plane_unsupported",
      });
      expect(writes.inserts).toHaveLength(0);
    });

    it("marks the head it writes as the main repository, which is what the index constrains", async () => {
      const writes = wire({ connections: [CONNECTED_CONNECTION] });
      await handler().run(INPUT, makeCTX());
      const head = writes.inserts.find(
        (w) => w.table === schema.repositoryBindingHeads,
      );
      expect(head?.values).toMatchObject({ role: "main" });
    });

    it("refuses an organisation on a dedicated data plane, where the index cannot see other planes", async () => {
      // ADR-042: a unique index is global only within one Postgres. Admitting
      // the bind there would allow the second claim this guard exists to
      // refuse, so it refuses rather than pretending to have checked.
      mocks.resolveDataPlane.mockResolvedValue({
        orgId: "org-uuid",
        kind: "postgres",
        mode: "dedicated",
        status: "active",
      });
      const writes = wire({ connections: [CONNECTED_CONNECTION] });

      const err = await handler()
        .run(INPUT, makeCTX())
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toMatchObject({
        code: "conflict",
        reason: "main_repo_plane_unsupported",
      });
      expect(writes.inserts).toHaveLength(0);
    });

    // The pre-check runs before the transaction opens, and `withTenantDb`
    // resolves the plane again for itself. Between the two an operator can
    // move the organisation, and the write would then land on a plane the
    // shared global index cannot see — a claim nobody else can detect.
    it("refuses inside the transaction when the plane moves after the pre-check", async () => {
      const writes = wire({ connections: [CONNECTED_CONNECTION] });
      // The pre-check reads the cached resolver and sees `shared`; the
      // re-validation inside the transaction reads `org.data_planes` directly
      // and does not. That is exactly the split the uncached read exists for:
      // a cached resolver would still be answering `shared` here.
      mocks.loadDataPlaneBinding.mockResolvedValue({
        orgId: "org-uuid",
        kind: "postgres",
        mode: "dedicated",
        status: "active",
      });

      const err = await handler()
        .run(INPUT, makeCTX())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({
        code: "conflict",
        reason: "main_repo_plane_unsupported",
      });
      expect(
        writes.inserts.filter((w) => w.table === schema.repositoryBindingHeads),
      ).toHaveLength(0);
    });
  });
});

/**
 * The GitLab arm (#3762). The project comes from the workspace's GitLab
 * connection, read by id through its project access token; the fake stands in
 * for that read. The GitLab arm makes no GitHub installation lookup, so the
 * first queued `withTenantDb` answer (the installation read `wire` arms) is
 * drained before the call.
 */
describe("bind_main_repository on GitLab", () => {
  const GITLAB_TARGET = {
    provider: "gitlab" as const,
    connection: {
      id: "gl-conn-uuid",
      publicId: "con_gl1",
      status: "connected",
    },
    repo: {
      // Numerically equal to a GitHub id elsewhere in this file on purpose.
      id: "4242",
      owner: "acme/platform",
      name: "rules",
      fullName: "acme/platform/rules",
      defaultBranch: "main",
    },
  };

  async function gitlabRun(selects: unknown[][] = [[], []]) {
    const writes = wire({ selects });
    await mocks.withTenantDb(async () => null);
    const gitlabProject = vi.fn(async () => GITLAB_TARGET);
    const repository = vi.fn(async () => REPO);
    const run = createMainRepositoryBindHandler({ repository, gitlabProject });
    return { writes, gitlabProject, repository, run };
  }

  it("binds the project by id with provider gitlab and a nested namespace owner", async () => {
    const { writes, gitlabProject, repository, run } = await gitlabRun();
    const out = await run(
      { provider: "gitlab", projectPath: "acme/platform/rules" },
      makeCTX(),
    );
    expect(gitlabProject).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: expect.any(String) }),
      "acme/platform/rules",
    );
    expect(repository).not.toHaveBeenCalled();
    const binding = writes.inserts.find(
      (w) => w.table === schema.repositoryBindings,
    );
    expect(binding?.values).toMatchObject({
      connectionId: "gl-conn-uuid",
      provider: "gitlab",
      providerRepositoryId: "4242",
      providerOwner: "acme/platform",
      providerName: "rules",
      providerFullName: "acme/platform/rules",
      configuredDefaultRef: "main",
    });
    const head = writes.inserts.find(
      (w) => w.table === schema.repositoryBindingHeads,
    );
    expect(head?.values).toMatchObject({ provider: "gitlab", role: "main" });
    expect(out).toMatchObject({
      provider: "gitlab",
      connectionId: "con_gl1",
      fullName: "acme/platform/rules",
      defaultRef: "main",
    });
  });

  it("does not mistake a GitHub head with the same id for this project", async () => {
    const { run } = await gitlabRun([
      [
        {
          id: "head-uuid",
          role: "main",
          provider: "github",
          connectionId: "conn-uuid",
          providerRepositoryId: "4242",
          currentBindingId: "binding-1",
        },
      ],
    ]);
    await expect(
      run(
        { provider: "gitlab", projectPath: "acme/platform/rules" },
        makeCTX(),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "main_repo_bound" });
  });

  it("passes the connection refusal through when the workspace has no GitLab connection", async () => {
    wire({});
    await mocks.withTenantDb(async () => null);
    const run = createMainRepositoryBindHandler({
      repository: vi.fn(),
      gitlabProject: vi.fn(async () => {
        const { gitlabNotConnected } = await import("./lib/gitlab-credential");
        throw gitlabNotConnected();
      }),
    });
    await expect(
      run({ provider: "gitlab", projectPath: "acme/rules" }, makeCTX()),
    ).rejects.toMatchObject({ reason: "gitlab_not_connected" });
  });
});
