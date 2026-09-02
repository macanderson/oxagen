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

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
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
      }),
  };
});

beforeEach(() => {
  deletedTables.length = 0;
  whereConditions.length = 0;
  deleteResult = [];
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

    const { deleteWorkspaceSecret } = await import("./workspace-credential");
    const out = await deleteWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l-missing",
    });

    expect(out).toBe(false);
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
