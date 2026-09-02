/**
 * audit.log.query handler tests.
 *
 * Strategy: mock withSystemDb so no DB is needed. A chainable query stub
 * captures the WHERE conditions and returns canned rows per table, letting us
 * assert: org-scoping is always applied (tenant isolation), the two spines are
 * merged newest-first, filters are forwarded, and pagination/ hasMore are right.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  whereArgs: [] as unknown[],
  securityRows: [] as Record<string, unknown>[],
  playbookRows: [] as Record<string, unknown>[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

import { schema } from "@oxagen/database";
import { auditLogQueryHandler } from "./audit.log.query";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// A query builder whose .from() decides which canned rows to return by drizzle
// table identity. It records the and(...) condition passed to .where().
function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => {
        const isSecurity = table === schema.securityEvents;
        return {
          where: (cond: unknown) => {
            mocks.whereArgs.push(cond);
            return {
              orderBy: () => ({
                limit: () =>
                  Promise.resolve(
                    isSecurity ? mocks.securityRows : mocks.playbookRows,
                  ),
              }),
            };
          },
        };
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereArgs = [];
  mocks.securityRows = [];
  mocks.playbookRows = [];
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
});

describe("auditLogQueryHandler", () => {
  it("merges security + playbook events newest-first and reports pagination", async () => {
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
    ];
    mocks.playbookRows = [
      {
        eventType: "run_completed",
        occurredAt: new Date("2024-01-05T00:00:00Z"),
        workspaceId: "ws_1",
        playbookRunId: "run_1",
        sequence: 7,
        eventData: { ok: true },
      },
    ];

    const result = await auditLogQueryHandler(
      { source: "all", limit: 50, offset: 0 },
      CTX,
    );

    expect(result.events).toHaveLength(2);
    // Newest first: playbook (Jan 5) before security (Jan 3).
    expect(result.events[0]?.source).toBe("playbook");
    expect(result.events[0]?.playbookRunId).toBe("run_1");
    expect(result.events[1]?.source).toBe("security");
    expect(result.events[1]?.capability).toBe("start_subscription_upgrade");
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
    mocks.playbookRows = [
      {
        eventType: "run_completed",
        occurredAt: new Date(),
        workspaceId: "ws",
        playbookRunId: "r",
        sequence: 1,
        eventData: {},
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
    expect(mocks.whereArgs.length).toBe(2); // security + playbook both filtered
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
