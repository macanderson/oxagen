/**
 * Unit tests for the list_credential_grants handler (spec §6.8, #2958).
 * Tier-free org; the role gate runs for real against a tx double. The page
 * read is an in-memory store applying the query's semantics (scope,
 * connection filter, newest first, cursor, limit + 1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  createCredentialGrantListHandler,
  grantStatus,
  type GrantRow,
  type PageQuery,
} from "./credential.grant.list";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const ctx = () => makeCTX({ orgId: ORG, workspaceId: WS, userId: USER });

function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

let seq = 0;
const uuid = (n: number) =>
  `0192d4a8-7c1e-7a00-8000-${String(n).padStart(12, "0")}`;

function grant(over: Partial<GrantRow> = {}): GrantRow {
  seq += 1;
  const issuedAt = new Date(Date.UTC(2026, 8, 15, 11, 0, seq));
  return {
    id: uuid(seq),
    publicId: `mcgr_${seq}`,
    connectionPublicId: "mcrd_gh",
    serverPublicId: "mcs_github",
    serverName: "GitHub",
    runId: "run_1",
    scope: {
      endpointUrl: "https://mcp.github.com/mcp",
      authKind: "oauth",
      downscope: "none",
    },
    providerTokenId: null,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000),
    revokedAt: null,
    ...over,
  };
}

function memoryPage(rows: GrantRow[]) {
  return async (_scope: unknown, q: PageQuery): Promise<GrantRow[]> =>
    rows
      .filter(
        (r) =>
          q.connectionId === null || r.connectionPublicId === q.connectionId,
      )
      .filter((r) => {
        if (!q.cursor) return true;
        const at = Date.parse(q.cursor.at);
        const t = r.issuedAt.getTime();
        return t < at || (t === at && r.id < q.cursor.id);
      })
      .sort(
        (a, b) =>
          b.issuedAt.getTime() - a.issuedAt.getTime() || (a.id < b.id ? 1 : -1),
      )
      .slice(0, q.limit + 1);
}

const handlerOver = (rows: GrantRow[]) =>
  createCredentialGrantListHandler({ page: memoryPage(rows) }, () => NOW);

beforeEach(() => {
  stubRole("Compliance");
});

describe("grantStatus", () => {
  it("is revoked, else expired past the TTL, else active", () => {
    const live = { expiresAt: new Date(NOW.getTime() + 1000), revokedAt: null };
    expect(grantStatus(live, NOW)).toBe("active");
    expect(grantStatus({ ...live, expiresAt: NOW }, NOW)).toBe("expired");
    expect(grantStatus({ ...live, revokedAt: NOW }, NOW)).toBe("revoked");
  });
});

describe("list_credential_grants", () => {
  it("lists grants newest first with connection, server, scope, TTL and status, and no secret", async () => {
    const rows = [
      grant(),
      grant({ revokedAt: new Date("2026-09-15T11:30:00.000Z") }),
      grant({ expiresAt: new Date("2026-09-15T11:59:00.000Z"), runId: null }),
    ];
    const out = await handlerOver(rows)({ limit: 50 }, ctx());
    expect(out.items.map((i) => i.id)).toEqual(["mcgr_3", "mcgr_2", "mcgr_1"]);
    expect(out.items.map((i) => i.status)).toEqual([
      "expired",
      "revoked",
      "active",
    ]);
    expect(out.items[2]).toMatchObject({
      connectionId: "mcrd_gh",
      serverId: "mcs_github",
      serverName: "GitHub",
      runId: "run_1",
      scope: {
        endpointUrl: "https://mcp.github.com/mcp",
        authKind: "oauth",
        downscope: "none",
      },
      expiresAt: new Date(
        rows[0]!.issuedAt.getTime() + 60 * 60 * 1000,
      ).toISOString(),
    });
    expect(out.items[0]?.runId).toBeNull();
    // Reach, never material: every field of a row is an id, the scope, a time or the status.
    expect(Object.keys(out.items[0]!).sort()).toEqual([
      "connectionId",
      "expiresAt",
      "id",
      "issuedAt",
      "providerTokenId",
      "revokedAt",
      "runId",
      "scope",
      "serverId",
      "serverName",
      "status",
    ]);
  });

  it("reads a grant whose server row was deleted by a plugin uninstall", async () => {
    // The regression. `mcp.credential_grants.mcp_server_id` carries no foreign
    // key and plugin.org.uninstall hard-deletes `mcp.mcp_servers` rows, so the
    // handler's LEFT JOIN returned nulls and `toItem` threw RangeError
    // unconditionally. Under a newest-first order the orphan lands on page 1,
    // and no cursor skips it and no filter excludes it — one uninstall made
    // the Connections grants log, an audit surface, permanently unreadable for
    // the workspace. The row now names its server the way it already named its
    // connection, at mint time, and there is no join to go null.
    const orphan = grant({
      serverPublicId: "mcs_uninstalled",
      serverName: "Acme (uninstalled)",
    });
    const out = await handlerOver([orphan, grant()])({ limit: 50 }, ctx());
    expect(out.items).toHaveLength(2);
    expect(out.items.map((i) => i.serverId)).toContain("mcs_uninstalled");
    expect(out.items.map((i) => i.serverName)).toContain("Acme (uninstalled)");
  });

  it("filters by connection and pages on an opaque cursor", async () => {
    const rows = [
      grant(),
      grant({ connectionPublicId: "mcrd_other" }),
      grant(),
    ];
    const handler = handlerOver(rows);
    const gh = await handler({ limit: 1, connectionId: "mcrd_gh" }, ctx());
    expect(gh.items).toHaveLength(1);
    expect(gh.nextCursor).not.toBeNull();
    const next = await handler(
      { limit: 1, connectionId: "mcrd_gh", cursor: gh.nextCursor! },
      ctx(),
    );
    expect(next.items.map((i) => i.connectionId)).toEqual(["mcrd_gh"]);
    expect(next.nextCursor).toBeNull();
    await expect(
      handler({ limit: 1, cursor: "nope" }, ctx()),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it("a broken scope fails the read rather than guessing", async () => {
    await expect(
      handlerOver([grant({ scope: { token: "leak" } })])({ limit: 50 }, ctx()),
    ).rejects.toThrow(/scope outside the schema/);
  });

  it.each(["Billing", "Member", null])(
    "refuses a tier-free org member holding %s with forbidden",
    async (role) => {
      stubRole(role);
      const err = await handlerOver([grant()])({ limit: 50 }, ctx()).catch(
        (e: unknown) => e,
      );
      expect(isHandlerError(err) && err.code).toBe("forbidden");
    },
  );
});
