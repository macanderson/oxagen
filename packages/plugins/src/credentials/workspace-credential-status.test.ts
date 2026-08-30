/**
 * workspace-credential-status.test.ts
 *
 * Covers listWorkspaceCredentialStatuses — the status-only bulk read backing
 * the "which installs are connected / need (re)auth" UI. Split from
 * workspace-credential.test.ts because that file's tx mock models the
 * .where().limit() chain used by getWorkspaceSecret; the status read awaits
 * .where(...) directly and needs a mock that resolves there.
 *
 * Key properties under test:
 *  - rows come back as {orgListingId, authKind, status, expiresAt} only (no
 *    encrypted columns are ever selected),
 *  - the query is tenant-scoped by BOTH orgId and workspaceId (withSystemDb
 *    bypasses RLS, so this predicate is the only tenant guard),
 *  - the read requires NO KMS key (AUTH_TOKEN_ENCRYPTION_KEY unset works).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ── DB mock ───────────────────────────────────────────────────────────────────
// Captures the selected column map and the where() condition; where() resolves
// directly to `selectResult` (no .limit() — the status read has none).

const selectedColumns: Array<Record<string, unknown>> = [];
const whereConditions: unknown[] = [];
let selectResult: Array<Record<string, unknown>> = [];

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: (cols: Record<string, unknown>) => {
          selectedColumns.push(cols);
          return {
            from: () => ({
              where: (cond: unknown) => {
                whereConditions.push(cond);
                return Promise.resolve(selectResult);
              },
            }),
          };
        },
      }),
  };
});

beforeEach(() => {
  selectedColumns.length = 0;
  whereConditions.length = 0;
  selectResult = [];
  // The status read must work with NO encryption key configured — enforce it
  // for every test in this file.
  delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  vi.resetModules();
});

describe("listWorkspaceCredentialStatuses", () => {
  it("returns rows mapped to {orgListingId, authKind, status, expiresAt}", async () => {
    const expiry = new Date("2030-01-01T00:00:00Z");
    selectResult = [
      {
        orgListingId: "l1",
        authKind: "oauth",
        status: "active",
        expiresAt: expiry,
      },
      {
        orgListingId: "l2",
        authKind: "secret",
        status: "needs_reauth",
        expiresAt: null,
      },
    ];

    const { listWorkspaceCredentialStatuses } = await import(
      "./workspace-credential"
    );
    const out = await listWorkspaceCredentialStatuses({
      orgId: "o1",
      workspaceId: "w1",
    });

    expect(out).toEqual([
      {
        orgListingId: "l1",
        authKind: "oauth",
        status: "active",
        expiresAt: expiry,
      },
      {
        orgListingId: "l2",
        authKind: "secret",
        status: "needs_reauth",
        expiresAt: null,
      },
    ]);
  });

  it("selects ONLY the status columns — never the encrypted secret columns", async () => {
    const { listWorkspaceCredentialStatuses } = await import(
      "./workspace-credential"
    );
    const { schema } = await import("@oxagen/database");
    await listWorkspaceCredentialStatuses({ orgId: "o1", workspaceId: "w1" });

    const cols = selectedColumns[0]!;
    expect(Object.keys(cols).sort()).toEqual([
      "authKind",
      "expiresAt",
      "orgListingId",
      "status",
    ]);
    // The selection maps to the real mcp.credentials columns.
    expect(cols["orgListingId"]).toBe(schema.mcpCredentials.orgListingId);
    expect(cols["authKind"]).toBe(schema.mcpCredentials.authKind);
    expect(cols["status"]).toBe(schema.mcpCredentials.status);
    expect(cols["expiresAt"]).toBe(schema.mcpCredentials.expiresAt);
  });

  it("scopes the query by BOTH orgId and workspaceId (RLS-bypassing tenant guard)", async () => {
    const { listWorkspaceCredentialStatuses } = await import(
      "./workspace-credential"
    );
    await listWorkspaceCredentialStatuses({
      orgId: "org-guard",
      workspaceId: "ws-guard",
    });

    expect(whereConditions).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(whereConditions[0] as SQL);
    // Both tenant predicates present, bound to exactly the caller's key.
    expect(rendered.sql).toContain("org_id");
    expect(rendered.sql).toContain("workspace_id");
    expect(rendered.params).toEqual(["org-guard", "ws-guard"]);
  });

  it("works with AUTH_TOKEN_ENCRYPTION_KEY unset and logs no misconfiguration error", async () => {
    expect(process.env.AUTH_TOKEN_ENCRYPTION_KEY).toBeUndefined();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      selectResult = [
        {
          orgListingId: "l1",
          authKind: "oauth",
          status: "active",
          expiresAt: null,
        },
      ];
      const { listWorkspaceCredentialStatuses } = await import(
        "./workspace-credential"
      );
      const out = await listWorkspaceCredentialStatuses({
        orgId: "o1",
        workspaceId: "w1",
      });
      expect(out).toHaveLength(1);
      // Unlike getWorkspaceSecret, the status read never touches the KMS, so
      // the missing-key ops alert must NOT fire.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns an empty array when the workspace has no credential rows", async () => {
    const { listWorkspaceCredentialStatuses } = await import(
      "./workspace-credential"
    );
    const out = await listWorkspaceCredentialStatuses({
      orgId: "o1",
      workspaceId: "w-empty",
    });
    expect(out).toEqual([]);
  });
});
