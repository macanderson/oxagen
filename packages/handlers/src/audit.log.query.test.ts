/**
 * audit.log.query handler tests.
 *
 * Strategy: mock withSystemDb so no DB is needed. A chainable query stub
 * captures the WHERE conditions and returns canned rows, letting us assert:
 * org-scoping is always applied (tenant isolation), the workspace predicate
 * defaults to the caller's own workspace, events come back newest-first,
 * filters are forwarded, and pagination / hasMore are right.
 *
 * ADR-043 removed the second spine (playbook_events) with the automations
 * subsystem, so `source: "playbook"` now matches nothing.
 *
 * The stub routes .from() by drizzle table identity because the handler now
 * reads org_users too — resolving whether the caller may widen past their own
 * workspace. `mocks.orgRole` is what that lookup returns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  whereArgs: [] as unknown[],
  securityRows: [] as Record<string, unknown>[],
  /** The caller's org_users.role, or null for "not a member of this org". */
  orgRole: null as string | null,
  tablesRead: [] as unknown[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

import { schema } from "@oxagen/database";
import { and, eq, type SQL } from "drizzle-orm";
import { auditLogQueryHandler } from "./audit.log.query";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

// A query builder whose .from() decides which canned rows to return by drizzle
// table identity. It records the and(...) condition passed to .where().
function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => {
        mocks.tablesRead.push(table);
        if (table === schema.orgUsers) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  mocks.orgRole === null ? [] : [{ role: mocks.orgRole }],
                ),
            }),
          };
        }
        // security_events is the only spine left; assert the handler never
        // reaches for another table.
        expect(table).toBe(schema.securityEvents);
        return {
          where: (cond: unknown) => {
            mocks.whereArgs.push(cond);
            return {
              orderBy: () => ({
                limit: () => Promise.resolve(mocks.securityRows),
              }),
            };
          },
        };
      },
    }),
  };
}

/**
 * Assert the captured WHERE is exactly the given conditions. Built with the
 * same drizzle helpers the handler uses, so this compares the predicate itself
 * rather than reaching into drizzle's SQL internals.
 */
function expectWhere(...conds: SQL[]): void {
  expect(mocks.whereArgs[0]).toStrictEqual(and(...conds));
}

const orgIs = (id: string): SQL => eq(schema.securityEvents.orgId, id);
const workspaceIs = (id: string): SQL =>
  eq(schema.securityEvents.workspaceId, id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereArgs = [];
  mocks.securityRows = [];
  mocks.tablesRead = [];
  // Default: the caller is an org Owner, which is what the pre-existing
  // assertions below (whole-org feed, no workspace predicate) describe.
  mocks.orgRole = "owner";
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
});

describe("auditLogQueryHandler", () => {
  it("returns security events newest-first and reports pagination", async () => {
    mocks.securityRows = [
      {
        eventType: "billing.plan_changed",
        occurredAt: new Date("2024-01-03T00:00:00Z"),
        actorUserId: "u1",
        workspaceId: "ws_1",
        capability: "start_subscription_upgrade",
        outcome: "success",
        requestId: "req1",
      },
      {
        eventType: "auth.sign_in",
        occurredAt: new Date("2024-01-05T00:00:00Z"),
        actorUserId: "u1",
        workspaceId: "ws_1",
        capability: null,
        outcome: "success",
        requestId: "req2",
      },
    ];

    const result = await auditLogQueryHandler(
      { source: "all", limit: 50, offset: 0 },
      CTX,
    );

    expect(result.events).toHaveLength(2);
    // Newest first: Jan 5 before Jan 3.
    expect(result.events[0]?.eventType).toBe("auth.sign_in");
    expect(result.events[1]?.capability).toBe("start_subscription_upgrade");
    expect(result.events.every((e) => e.source === "security")).toBe(true);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(2);
  });

  it("only queries the security spine when source=security", async () => {
    mocks.securityRows = [
      {
        eventType: "auth.sign_in",
        occurredAt: new Date("2024-01-01T00:00:00Z"),
        actorUserId: "u1",
        workspaceId: null,
        capability: null,
        outcome: "success",
        requestId: null,
      },
    ];

    const result = await auditLogQueryHandler(
      { source: "security", limit: 50, offset: 0 },
      CTX,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events.every((e) => e.source === "security")).toBe(true);
    // Exactly one table was queried.
    expect(mocks.whereArgs).toHaveLength(1);
  });

  it("always scopes by orgId (tenant-isolation guard)", async () => {
    // The handler must call withSystemDb and apply an org filter. We assert the
    // capability cannot run without producing a WHERE clause per queried table.
    await auditLogQueryHandler({ source: "all", limit: 10, offset: 0 }, CTX);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.whereArgs.length).toBe(1); // the one surviving spine, filtered
  });

  it("reports hasMore when more events exist than the page window", async () => {
    // 2 security rows, limit 1 → after merge, page=1 and hasMore=true.
    mocks.securityRows = [
      {
        eventType: "a",
        occurredAt: new Date("2024-01-02T00:00:00Z"),
        actorUserId: null,
        workspaceId: null,
        capability: null,
        outcome: "allow",
        requestId: null,
      },
      {
        eventType: "b",
        occurredAt: new Date("2024-01-01T00:00:00Z"),
        actorUserId: null,
        workspaceId: null,
        capability: null,
        outcome: "allow",
        requestId: null,
      },
    ];

    const result = await auditLogQueryHandler(
      { source: "security", limit: 1, offset: 0 },
      CTX,
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe("a"); // newest
    expect(result.hasMore).toBe(true);
  });
});

describe("auditLogQueryHandler — workspace boundary", () => {
  // The finding: a member scoped to one workspace received the whole org's
  // security feed, because the workspace predicate was applied only when the
  // caller happened to name a workspace in the input.
  it("defaults the workspace predicate to ctx.workspaceId for a non-org-admin", async () => {
    mocks.orgRole = "member";

    await auditLogQueryHandler(
      { source: "security", limit: 50, offset: 0 },
      CTX,
    );

    expectWhere(orgIs(CTX.orgId), workspaceIs(CTX.workspaceId));
  });

  it("omits the workspace predicate for an org Owner (the Governance hub feed)", async () => {
    mocks.orgRole = "owner";

    await auditLogQueryHandler(
      { source: "security", limit: 50, offset: 0 },
      CTX,
    );

    expectWhere(orgIs(CTX.orgId));
  });

  it("accepts an org role written in the capitalized SystemOrgRole casing", async () => {
    // org_users.role is stored in both casings; a case-sensitive compare would
    // deny a legitimately promoted admin.
    mocks.orgRole = "Admin";

    await auditLogQueryHandler(
      { source: "security", limit: 50, offset: 0 },
      CTX,
    );

    expectWhere(orgIs(CTX.orgId));
  });

  it("refuses another workspace to a caller with no org role", async () => {
    mocks.orgRole = "member";

    await expect(
      auditLogQueryHandler(
        { source: "security", limit: 50, offset: 0, workspaceId: "ws_other" },
        CTX,
      ),
    ).rejects.toThrow(/Forbidden/);
    // Refused before the spine was read, not after.
    expect(mocks.whereArgs).toHaveLength(0);
  });

  it("allows an org Admin to name a sibling workspace", async () => {
    mocks.orgRole = "admin";

    await auditLogQueryHandler(
      { source: "security", limit: 50, offset: 0, workspaceId: "ws_other" },
      CTX,
    );

    expectWhere(orgIs(CTX.orgId), workspaceIs("ws_other"));
  });

  it("does not consult org_users when the caller asks for its own workspace", async () => {
    mocks.orgRole = "member";

    await auditLogQueryHandler(
      {
        source: "security",
        limit: 50,
        offset: 0,
        workspaceId: CTX.workspaceId,
      },
      CTX,
    );

    expect(mocks.tablesRead).not.toContain(schema.orgUsers);
  });

  it("fails closed for an API key with no user and no workspace scope", async () => {
    // No userId means no org membership to read, and an empty workspaceId
    // leaves no scope to narrow to — there is nothing this caller may read.
    mocks.orgRole = null;

    await expect(
      auditLogQueryHandler(
        { source: "security", limit: 50, offset: 0 },
        makeCTX({ userId: null, workspaceId: "" }),
      ),
    ).rejects.toThrow(/Forbidden/);
  });
});
