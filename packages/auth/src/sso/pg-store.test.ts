/**
 * Unit tests for the Postgres side of SSO role mapping (./pg-store.ts).
 *
 * withSystemDb is replaced by a fake transaction that records every
 * statement it is asked to run and answers each awaited statement from a
 * per-test queue, in the order the code awaits them. drizzle-orm's helpers
 * become plain tokens, so an assertion can read which table and which
 * columns a statement touched without compiling SQL.
 *
 * The role write moved to @oxagen/database/member-lifecycle, where its
 * invariants are tested: an Owner is never touched, no mapped group is a full
 * member removal, and a grant that did not take throws. Here the store must
 * read the right rows and run that write once, in one transaction.
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

const { orgHasSso } = vi.hoisted(() => ({
  orgHasSso: vi.fn(async () => true),
}));
vi.mock("./entitlement", () => ({ orgHasSso }));

const { applyMappedOrgRoleInTx } = vi.hoisted(() => ({
  applyMappedOrgRoleInTx: vi.fn(),
}));
vi.mock("@oxagen/database/member-lifecycle", () => ({
  applyMappedOrgRoleInTx,
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
const PROVIDER = "acme-okta";

beforeEach(() => {
  withSystemDbMock.mockReset();
  applyMappedOrgRoleInTx.mockReset();
});

describe("createPgSsoProvisioningStore().applyRole", () => {
  // The role write itself is applyMappedOrgRoleInTx, proven statement by
  // statement in packages/database/src/member-lifecycle.test.ts. Here the store
  // must run it once, in one withSystemDb transaction, as the person signing
  // in, and report a SCIM suspension back to the provisioner.
  it("runs the shared role write in one withSystemDb transaction", async () => {
    const { tx } = useTx([]);
    applyMappedOrgRoleInTx.mockResolvedValueOnce({
      kind: "granted",
      role: "admin",
    });
    await expect(
      createPgSsoProvisioningStore().applyRole({
        orgId: ORG,
        userId: USER,
        providerId: PROVIDER,
        role: "admin",
      }),
    ).resolves.toBe("applied");
    expect(withSystemDbMock).toHaveBeenCalledTimes(1);
    expect(applyMappedOrgRoleInTx).toHaveBeenCalledWith(tx, {
      orgId: ORG,
      userId: USER,
      role: "admin",
      actorId: USER,
      trigger: "sso_deny",
    });
  });

  it("hands a null role to the shared removal", async () => {
    useTx([]);
    applyMappedOrgRoleInTx.mockResolvedValueOnce({
      kind: "removed",
      removal: {} as never,
    });
    await expect(
      createPgSsoProvisioningStore().applyRole({
        orgId: ORG,
        userId: USER,
        providerId: PROVIDER,
        role: null,
      }),
    ).resolves.toBe("applied");
    expect(applyMappedOrgRoleInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: null, trigger: "sso_deny" }),
    );
  });

  it("reports a person a SCIM deprovision suspended", async () => {
    useTx([]);
    applyMappedOrgRoleInTx.mockResolvedValueOnce({ kind: "scim_suspended" });
    await expect(
      createPgSsoProvisioningStore().applyRole({
        orgId: ORG,
        userId: USER,
        providerId: PROVIDER,
        role: "member",
      }),
    ).resolves.toBe("scim_suspended");
  });
});

describe("createPgSsoProvisioningStore().entitled", () => {
  it("asks the plan whether it includes SSO", async () => {
    orgHasSso.mockResolvedValueOnce(false);
    await expect(
      createPgSsoProvisioningStore().entitled("org_1"),
    ).resolves.toBe(false);
    expect(orgHasSso).toHaveBeenCalledWith("org_1");
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
      createPgSsoProvisioningStore().groupRoles("org_1", "prov_1"),
    ).resolves.toEqual([
      { group: "eng-admins", role: "admin" },
      { group: "everyone", role: "member" },
    ]);
    expect(tableOf(statements[0]!)).toBe("ssoGroupRoles");
    expect(callOf(statements[0]!, "where")!.args[0]).toEqual({
      and: [
        { eq: ["ssoGroupRoles.orgId", "org_1"] },
        { eq: ["ssoGroupRoles.providerId", "prov_1"] },
      ],
    });
  });

  it("returns an empty list for a provider with no mapping", async () => {
    useTx([[]]);
    await expect(
      createPgSsoProvisioningStore().groupRoles("org_1", "prov_1"),
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
