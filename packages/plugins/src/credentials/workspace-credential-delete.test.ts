/**
 * workspace-credential-delete.test.ts
 *
 * Covers deleteWorkspaceSecret — the "Remove authentication" action backing
 * revoke_plugin_credential. Split from workspace-credential.test.ts because
 * that file's tx mock models the insert/select chains; the delete awaits
 * .delete().where().returning() and needs a mock that resolves there.
 *
 * Key properties under test:
 *  - returns true when a row was deleted, false when none existed,
 *  - the delete is tenant-scoped by orgId AND workspaceId AND orgListingId
 *    (withSystemDb bypasses RLS, so the orgId predicate is the only tenant
 *    guard),
 *  - the delete requires NO KMS key (AUTH_TOKEN_ENCRYPTION_KEY unset works —
 *    nothing is decrypted).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ── DB mock ───────────────────────────────────────────────────────────────────
// Captures the deleted table and the where() condition; returning() resolves
// to `deleteResult` (the rows drizzle reports as deleted).

const deletedTables: unknown[] = [];
const whereConditions: unknown[] = [];
let deleteResult: Array<Record<string, unknown>> = [];
/**
 * The credential rows the delete would take. The handler reads these first so
 * it can ask whether a kill switch names one (ADR-071). Defaults to one row,
 * so a test that only sets `deleteResult` behaves as it did before.
 */
let credentialRows: Array<Record<string, unknown>> = [];
/** Active kill switches the emergency_denies read returns. */
let killSwitchRows: Array<Record<string, unknown>> = [];
/** Every grant revocation the delete issued: the table updated and its where(). */
const revocations: Array<{ table: unknown; cond: unknown }> = [];
/** Every select the delete issued: the table read and its where(). */
const selects: Array<{ table: unknown; cond: unknown }> = [];

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: (table: unknown) => ({
            where: (cond: unknown) => {
              selects.push({ table, cond });
              return Promise.resolve(
                table === real.schema.emergencyDenies
                  ? killSwitchRows
                  : credentialRows,
              );
            },
          }),
        }),
        delete: (table: unknown) => {
          deletedTables.push(table);
          return {
            where: (cond: unknown) => {
              whereConditions.push(cond);
              return {
                returning: () => Promise.resolve(deleteResult),
              };
            },
          };
        },
        update: (table: unknown) => ({
          set: () => ({
            where: (cond: unknown) => {
              revocations.push({ table, cond });
              return { returning: () => Promise.resolve([{ id: "g1" }]) };
            },
          }),
        }),
      }),
  };
});

beforeEach(() => {
  deletedTables.length = 0;
  whereConditions.length = 0;
  revocations.length = 0;
  selects.length = 0;
  deleteResult = [];
  credentialRows = [{ id: "cred-1", publicId: "mcrd_gh" }];
  killSwitchRows = [];
  // The delete must work with NO encryption key configured — enforce it for
  // every test in this file.
  delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  vi.resetModules();
});

describe("deleteWorkspaceSecret", () => {
  it("returns true when a credential row was deleted", async () => {
    deleteResult = [{ id: "cred-1" }];

    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    const out = await deleteWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l1",
    });

    expect(out).toBe(true);
  });

  it("returns false when no credential row existed", async () => {
    deleteResult = [];
    credentialRows = [];

    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    const out = await deleteWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l-missing",
    });

    expect(out).toBe(false);
  });

  it("revokes the deleted connection's live grants in the same transaction (spec §6.8)", async () => {
    deleteResult = [{ id: "cred-1" }];
    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    const { schema } = await import("@oxagen/database");
    await deleteWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l1",
    });

    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.table).toBe(schema.mcpCredentialGrants);
    const sql = new PgDialect()
      .sqlToQuery(revocations[0]?.cond as SQL)
      .sql.toLowerCase();
    expect(sql).toContain("connection_id");
    expect(sql).toContain("revoked_at");
  });

  it("revokes nothing when no credential row existed", async () => {
    deleteResult = [];
    credentialRows = [];
    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    await deleteWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l-missing",
    });
    expect(revocations).toEqual([]);
  });

  it("deletes from mcp.credentials only", async () => {
    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    const { schema } = await import("@oxagen/database");
    await deleteWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l1",
    });

    expect(deletedTables).toEqual([schema.mcpCredentials]);
  });

  it("scopes the delete by orgId AND workspaceId AND orgListingId (RLS-bypassing tenant guard)", async () => {
    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    await deleteWorkspaceSecret({
      orgId: "org-guard",
      workspaceId: "ws-guard",
      orgListingId: "listing-guard",
    });

    expect(whereConditions).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(whereConditions[0] as SQL);
    // All three predicates present, bound to exactly the caller's key — a
    // guessed/leaked (workspaceId, orgListingId) pair from another tenant can
    // never delete that tenant's credential.
    expect(rendered.sql).toContain("org_id");
    expect(rendered.sql).toContain("workspace_id");
    expect(rendered.sql).toContain("org_listing_id");
    expect(rendered.params).toEqual(["org-guard", "ws-guard", "listing-guard"]);
  });

  it("refuses while a connection kill switch names the credential (ADR-071)", async () => {
    // The blocker this guard exists for. `set_kill_switch` denies on a digest
    // over `mcp.credentials.id`. Deleting the row and re-authenticating mints a
    // new uuid, so the deny matches nothing and the connection is live again
    // while `list_kill_switches` still reports the switch on and names the
    // stale id. Any workspace member can press "Remove authentication"; a kill
    // switch needs an org Owner or Admin. So the delete is refused instead.
    deleteResult = [{ id: "cred-1" }];
    killSwitchRows = [
      {
        id: "d1",
        publicId: "emd_7",
        targetKind: "connection",
        targetId: "mcrd_gh",
        scopeKind: "workspace",
        workspaceId: "w1",
        capabilityId: null,
        resourceScopeDigest: "digest-over-the-old-uuid",
        principalId: null,
        reason: "token leaked",
        active: true,
        activatedAt: new Date("2026-09-16T00:00:00Z"),
        deactivatedAt: null,
        flippedByUserId: null,
        updatedByUserId: null,
      },
    ];

    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    await expect(
      deleteWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l1",
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "kill_switch_on" });

    // Nothing was deleted and no grant was revoked — the guard runs in the
    // same transaction, before the delete.
    expect(deletedTables).toEqual([]);
    expect(revocations).toEqual([]);
  });

  it("names the switch and its target in the refusal", async () => {
    deleteResult = [{ id: "cred-1" }];
    killSwitchRows = [
      {
        id: "d1",
        publicId: "emd_7",
        targetKind: "connection",
        targetId: "mcrd_gh",
        scopeKind: "workspace",
        workspaceId: "w1",
        capabilityId: null,
        resourceScopeDigest: "digest",
        principalId: null,
        reason: "token leaked",
        active: true,
        activatedAt: new Date("2026-09-16T00:00:00Z"),
        deactivatedAt: null,
        flippedByUserId: null,
        updatedByUserId: null,
      },
    ];
    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    await expect(
      deleteWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l1",
      }),
    ).rejects.toThrow(/emd_7[\s\S]*connection mcrd_gh/);
  });

  it("asks emergency_denies about the credential it is about to delete", async () => {
    deleteResult = [{ id: "cred-1" }];
    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    const { schema } = await import("@oxagen/database");
    await deleteWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l1",
    });

    // Two reads: the credentials to delete, then the switches naming them.
    expect(selects.map((s) => s.table)).toEqual([
      schema.mcpCredentials,
      schema.emergencyDenies,
    ]);
    const rendered = new PgDialect().sqlToQuery(selects[1]!.cond as SQL);
    expect(rendered.sql).toContain("target_kind");
    expect(rendered.sql).toContain("target_id");
    expect(rendered.params).toEqual(["o1", true, "connection", "mcrd_gh"]);
  });

  it("does not ask about switches when the workspace holds no credential", async () => {
    deleteResult = [];
    credentialRows = [];
    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    const { schema } = await import("@oxagen/database");
    expect(
      await deleteWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l-missing",
      }),
    ).toBe(false);
    expect(selects.map((s) => s.table)).toEqual([schema.mcpCredentials]);
  });

  it("works with AUTH_TOKEN_ENCRYPTION_KEY unset and logs no misconfiguration error", async () => {
    expect(process.env.AUTH_TOKEN_ENCRYPTION_KEY).toBeUndefined();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      deleteResult = [{ id: "cred-1" }];
      const { deleteWorkspaceSecret } = await import("./workspace-credential");
      const out = await deleteWorkspaceSecret({
        orgId: "o1",
        workspaceId: "w1",
        orgListingId: "l1",
      });
      expect(out).toBe(true);
      // Unlike getWorkspaceSecret, the delete never touches the KMS, so the
      // missing-key ops alert must NOT fire.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
