/**
 * Unit tests for the Postgres side of SSO role mapping (./pg-store.ts).
 *
 * withSystemDb is replaced by a fake transaction that records every
 * statement it is asked to run and answers each awaited statement from a
 * per-test queue, in the order the code awaits them. drizzle-orm's helpers
 * become plain tokens, so an assertion can read which table and which
 * columns a statement touched without compiling SQL.
 *
 * The invariants under test are the ones a wrong answer here costs:
 *   - an Owner is never touched by SSO (no write at all);
 *   - no mapped group means no role and no membership (deny by default);
 *   - a grant resurrects with onConflictDoUpdate and is re-read before the
 *     transaction commits, so a grant that did not take throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above this file's top-level code, so what
// they close over is built in vi.hoisted.
const { withSystemDbMock, schemaProxy } = vi.hoisted(() => {
  // Every table is a proxy that names its columns "<table>.<column>", so a
  // recorded where clause reads as the columns it filtered on.
  const table = (name: string) =>
    new Proxy(
      {},
      {
        get: (_c, column) =>
          typeof column === "string"
            ? column === "__table"
              ? name
              : `${name}.${column}`
            : undefined,
      },
    );
  return {
    withSystemDbMock: vi.fn(),
    schemaProxy: new Proxy(
      {},
      {
        get: (_t, name) => (typeof name === "string" ? table(name) : undefined),
      },
    ),
  };
});

vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) => withSystemDbMock(fn),
  schema: schemaProxy,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
}));

import { createPgSsoProvisioningStore } from "./pg-store";

interface Call {
  method: string;
  args: unknown[];
}
interface Statement {
  kind: "select" | "insert" | "update" | "delete";
  calls: Call[];
}

const CHAIN = [
  "from",
  "where",
  "limit",
  "for",
  "innerJoin",
  "values",
  "set",
  "onConflictDoNothing",
  "onConflictDoUpdate",
  "returning",
] as const;

/**
 * A fake Tx. Each select/insert/update/delete opens a statement; awaiting it
 * shifts the next answer off `answers`. Running out of answers is a test bug,
 * so it throws rather than resolving undefined.
 */
function makeTx(answers: unknown[]) {
  const statements: Statement[] = [];
  const open =
    (kind: Statement["kind"]) =>
    (...args: unknown[]) => {
      const stmt: Statement = { kind, calls: [{ method: kind, args }] };
      statements.push(stmt);
      const builder: Record<string, unknown> = {};
      for (const m of CHAIN) {
        builder[m] = (...a: unknown[]) => {
          stmt.calls.push({ method: m, args: a });
          return builder;
        };
      }
      builder.then = (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) => {
        if (answers.length === 0) {
          return Promise.reject(
            new Error(`unexpected statement #${statements.length}: ${kind}`),
          ).then(resolve, reject);
        }
        return Promise.resolve(answers.shift()).then(resolve, reject);
      };
      return builder;
    };
  const tx = {
    select: open("select"),
    insert: open("insert"),
    update: open("update"),
    delete: open("delete"),
  };
  return { tx, statements };
}

function useTx(answers: unknown[]) {
  const fake = makeTx(answers);
  withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(fake.tx),
  );
  return fake;
}

/** The table a statement reads or writes. */
function tableOf(stmt: Statement): string {
  const target =
    stmt.kind === "select"
      ? stmt.calls.find((c) => c.method === "from")?.args[0]
      : stmt.calls[0]!.args[0];
  return (target as { __table: string }).__table;
}

function callOf(stmt: Statement, method: string): Call | undefined {
  return stmt.calls.find((c) => c.method === method);
}

const writes = (statements: Statement[]) =>
  statements.filter((s) => s.kind !== "select");

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const PRINCIPAL = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000004";
const PRA_ID = "00000000-0000-4000-8000-000000000005";
const PROVIDER = "acme-okta";

beforeEach(() => {
  withSystemDbMock.mockReset();
});

describe("createPgSsoProvisioningStore().applyRole", () => {
  it("leaves an Owner untouched: one locked read and no write", async () => {
    const { statements } = useTx([[{ role: "Owner" }]]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: null,
    });
    expect(statements).toHaveLength(1);
    expect(tableOf(statements[0]!)).toBe("orgUsers");
    // The read locks the row so a concurrent promotion to Owner wins.
    expect(callOf(statements[0]!, "for")?.args).toEqual(["update"]);
  });

  it("treats a lowercase owner the same way", async () => {
    const { statements } = useTx([[{ role: "owner" }]]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "admin",
    });
    expect(writes(statements)).toEqual([]);
  });

  it("with no mapped role, revokes org-wide assignments and removes the membership", async () => {
    const { statements } = useTx([
      [{ role: "admin" }], // member row
      [{ id: PRINCIPAL }], // existing principal
      undefined, // revoke
      undefined, // delete org_users
    ]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: null,
    });

    const w = writes(statements);
    expect(w.map((s) => [s.kind, tableOf(s)])).toEqual([
      ["update", "principalRoleAssignments"],
      ["delete", "orgUsers"],
    ]);
    const revoke = w[0]!;
    const set = callOf(revoke, "set")!.args[0] as Record<string, unknown>;
    expect(set.deletedAt).toBeInstanceOf(Date);
    expect(set.deletedById).toBe(USER);
    // Only live, org-wide rows of this principal in this org are revoked.
    expect(callOf(revoke, "where")!.args[0]).toEqual({
      and: [
        { eq: ["principalRoleAssignments.principalId", PRINCIPAL] },
        { eq: ["principalRoleAssignments.orgId", ORG] },
        { isNull: "principalRoleAssignments.workspaceId" },
        { isNull: "principalRoleAssignments.deletedAt" },
      ],
    });
    expect(callOf(w[1]!, "where")!.args[0]).toEqual({
      and: [{ eq: ["orgUsers.orgId", ORG] }, { eq: ["orgUsers.userId", USER] }],
    });
  });

  it("grants Admin: resurrecting upsert, post-condition read, then org_users upsert", async () => {
    const { statements } = useTx([
      [{ role: "member" }], // member row
      [{ id: PRINCIPAL }], // existing principal
      undefined, // revoke
      [{ id: ROLE_ID }], // IAM role lookup
      undefined, // PRA upsert
      [{ id: PRA_ID }], // post-condition read
      undefined, // org_users upsert
    ]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "admin",
    });

    const roleLookup = statements.find(
      (s) => s.kind === "select" && tableOf(s) === "roles",
    )!;
    expect(callOf(roleLookup, "where")!.args[0]).toEqual({
      and: [
        { eq: ["roles.orgId", ORG] },
        { eq: ["roles.scopeKind", "org"] },
        { eq: ["roles.name", "Admin"] },
      ],
    });

    const w = writes(statements);
    expect(w.map((s) => [s.kind, tableOf(s)])).toEqual([
      ["update", "principalRoleAssignments"],
      ["insert", "principalRoleAssignments"],
      ["insert", "orgUsers"],
    ]);

    const grant = w[1]!;
    expect(callOf(grant, "values")!.args[0]).toMatchObject({
      principalId: PRINCIPAL,
      roleId: ROLE_ID,
      orgId: ORG,
      assignedBy: USER,
    });
    // Never onConflictDoNothing: a soft-deleted row must come back to life.
    expect(callOf(grant, "onConflictDoNothing")).toBeUndefined();
    const conflict = callOf(grant, "onConflictDoUpdate")!.args[0] as {
      target: unknown[];
      targetWhere: unknown;
      set: Record<string, unknown>;
    };
    expect(conflict.target).toEqual([
      "principalRoleAssignments.principalId",
      "principalRoleAssignments.roleId",
      "principalRoleAssignments.orgId",
    ]);
    expect(conflict.targetWhere).toEqual({
      isNull: "principalRoleAssignments.workspaceId",
    });
    expect(conflict.set).toMatchObject({
      deletedAt: null,
      deletedById: null,
      expiresAt: null,
    });

    const membership = w[2]!;
    expect(callOf(membership, "values")!.args[0]).toMatchObject({
      orgId: ORG,
      userId: USER,
      role: "admin",
    });
    const memberConflict = callOf(membership, "onConflictDoUpdate")!
      .args[0] as { target: unknown[]; set: Record<string, unknown> };
    expect(memberConflict.target).toEqual([
      "orgUsers.orgId",
      "orgUsers.userId",
    ]);
    expect(memberConflict.set.role).toBe("admin");
  });

  it.each([
    ["compliance", "Compliance"],
    ["billing", "Billing"],
  ] as const)("maps %s to the %s IAM role", async (role, iamName) => {
    const { statements } = useTx([
      [],
      [{ id: PRINCIPAL }],
      undefined,
      [{ id: ROLE_ID }],
      undefined,
      [{ id: PRA_ID }],
      undefined,
    ]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role,
    });
    const roleLookup = statements.find(
      (s) => s.kind === "select" && tableOf(s) === "roles",
    )!;
    expect(
      (callOf(roleLookup, "where")!.args[0] as { and: unknown[] }).and,
    ).toContainEqual({ eq: ["roles.name", iamName] });
  });

  it("throws when the grant did not take, so the revocation rolls back", async () => {
    const { statements } = useTx([
      [{ role: "admin" }],
      [{ id: PRINCIPAL }],
      undefined,
      [{ id: ROLE_ID }],
      undefined,
      [], // post-condition read finds nothing
    ]);
    await expect(
      createPgSsoProvisioningStore().applyRole({
        orgId: ORG,
        userId: USER,
        providerId: PROVIDER,
        role: "admin",
      }),
    ).rejects.toThrow(/did not take/);
    // Nothing after the failed post-condition: org_users is not rewritten.
    expect(
      writes(statements).some(
        (s) => s.kind === "insert" && tableOf(s) === "orgUsers",
      ),
    ).toBe(false);
  });

  it("throws when the organisation has no such IAM role", async () => {
    useTx([[{ role: "member" }], [{ id: PRINCIPAL }], undefined, []]);
    await expect(
      createPgSsoProvisioningStore().applyRole({
        orgId: ORG,
        userId: USER,
        providerId: PROVIDER,
        role: "compliance",
      }),
    ).rejects.toThrow(/no 'Compliance' org role/);
  });

  it("maps member to membership with no org-wide role", async () => {
    const { statements } = useTx([
      [{ role: "admin" }], // an Admin demoted by the IdP
      [{ id: PRINCIPAL }],
      undefined, // revoke
      undefined, // org_users upsert
    ]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "member",
    });
    expect(
      statements.some((s) => s.kind === "select" && tableOf(s) === "roles"),
    ).toBe(false);
    const w = writes(statements);
    expect(w.map((s) => [s.kind, tableOf(s)])).toEqual([
      ["update", "principalRoleAssignments"],
      ["insert", "orgUsers"],
    ]);
    expect(callOf(w[1]!, "values")!.args[0]).toMatchObject({ role: "member" });
  });

  it("creates the member principal when none exists, named after the user", async () => {
    const { statements } = useTx([
      [], // no membership yet: first SSO sign-in
      [], // no principal
      [{ displayName: "Ada Lovelace", email: "ada@example.com" }],
      [{ id: PRINCIPAL }], // insert returning
      undefined, // revoke
      undefined, // org_users upsert
    ]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "member",
    });
    const insert = statements.find(
      (s) => s.kind === "insert" && tableOf(s) === "principals",
    )!;
    expect(callOf(insert, "values")!.args[0]).toMatchObject({
      orgId: ORG,
      kind: "human",
      displayName: "Ada Lovelace",
      status: "active",
      parentUserId: USER,
    });
    expect(callOf(insert, "onConflictDoNothing")).toBeDefined();
    const revoke = statements.find((s) => s.kind === "update")!;
    expect(
      (callOf(revoke, "where")!.args[0] as { and: unknown[] }).and,
    ).toContainEqual({
      eq: ["principalRoleAssignments.principalId", PRINCIPAL],
    });
  });

  it("falls back to the email, then the user id, for the principal's name", async () => {
    const byEmail = useTx([
      [],
      [],
      [{ displayName: null, email: "ada@example.com" }],
      [{ id: PRINCIPAL }],
      undefined,
      undefined,
    ]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "member",
    });
    const first = byEmail.statements.find(
      (s) => s.kind === "insert" && tableOf(s) === "principals",
    )!;
    expect(callOf(first, "values")!.args[0]).toMatchObject({
      displayName: "ada@example.com",
    });

    const byId = useTx([[], [], [], [{ id: PRINCIPAL }], undefined, undefined]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "member",
    });
    const second = byId.statements.find(
      (s) => s.kind === "insert" && tableOf(s) === "principals",
    )!;
    expect(callOf(second, "values")!.args[0]).toMatchObject({
      displayName: USER,
    });
  });

  it("reads the winner's principal after losing an insert race", async () => {
    const { statements } = useTx([
      [],
      [],
      [{ displayName: "Ada", email: "ada@example.com" }],
      [], // insert conflicted: nothing returned
      [{ id: PRINCIPAL }], // reselect
      undefined,
      undefined,
    ]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "member",
    });
    const principalReads = statements.filter(
      (s) => s.kind === "select" && tableOf(s) === "principals",
    );
    expect(principalReads).toHaveLength(2);
    const revoke = statements.find((s) => s.kind === "update")!;
    expect(
      (callOf(revoke, "where")!.args[0] as { and: unknown[] }).and,
    ).toContainEqual({
      eq: ["principalRoleAssignments.principalId", PRINCIPAL],
    });
  });

  it("throws when neither the insert nor the reselect yields a principal", async () => {
    const { statements } = useTx([[], [], [], [], []]);
    await expect(
      createPgSsoProvisioningStore().applyRole({
        orgId: ORG,
        userId: USER,
        providerId: PROVIDER,
        role: "member",
      }),
    ).rejects.toThrow(/could not create a principal/);
    expect(statements.some((s) => s.kind === "update")).toBe(false);
  });

  it("runs the whole change in one withSystemDb transaction", async () => {
    useTx([[{ role: "Owner" }]]);
    await createPgSsoProvisioningStore().applyRole({
      orgId: ORG,
      userId: USER,
      providerId: PROVIDER,
      role: "admin",
    });
    expect(withSystemDbMock).toHaveBeenCalledTimes(1);
  });
});

describe("createPgSsoProvisioningStore().groupRoles", () => {
  it("reads the provider's mapping rows", async () => {
    const { statements } = useTx([
      [
        { group: "eng-admins", role: "admin" },
        { group: "everyone", role: "member" },
      ],
    ]);
    await expect(
      createPgSsoProvisioningStore().groupRoles("prov_1"),
    ).resolves.toEqual([
      { group: "eng-admins", role: "admin" },
      { group: "everyone", role: "member" },
    ]);
    expect(tableOf(statements[0]!)).toBe("ssoGroupRoles");
    expect(callOf(statements[0]!, "where")!.args[0]).toEqual({
      eq: ["ssoGroupRoles.providerId", "prov_1"],
    });
  });

  it("returns an empty list for a provider with no mapping", async () => {
    useTx([[]]);
    await expect(
      createPgSsoProvisioningStore().groupRoles("prov_1"),
    ).resolves.toEqual([]);
  });
});

describe("createPgSsoProvisioningStore().currentRole", () => {
  it("lowercases the stored role", async () => {
    const { statements } = useTx([[{ role: "Owner" }]]);
    await expect(
      createPgSsoProvisioningStore().currentRole(ORG, USER),
    ).resolves.toBe("owner");
    expect(callOf(statements[0]!, "where")!.args[0]).toEqual({
      and: [{ eq: ["orgUsers.orgId", ORG] }, { eq: ["orgUsers.userId", USER] }],
    });
  });

  it("returns null for a person with no membership", async () => {
    useTx([[]]);
    await expect(
      createPgSsoProvisioningStore().currentRole(ORG, USER),
    ).resolves.toBeNull();
  });
});
