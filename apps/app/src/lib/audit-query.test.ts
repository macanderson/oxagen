/**
 * audit-query.test.ts — unit tests for queryAuditPage / queryAuditForExport.
 *
 * Regression for the silent-truncation fix: the VIEWER path may swallow a DB
 * error into an empty page (renders without crashing), but the EXPORT path must
 * PROPAGATE the error — otherwise a mid-export failure would be HMAC-signed as a
 * complete-but-truncated SOC 2 evidence file, an undetectable gap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbState } = vi.hoisted(() => ({
  dbState: {
    // Queue of results per fetch call. Each entry is either an array of rows or
    // an Error to throw. Pulled in order.
    queue: [] as Array<unknown[] | Error>,
  },
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              const next = dbState.queue.shift();
              if (next instanceof Error) return Promise.reject(next);
              return Promise.resolve(next ?? []);
            },
          }),
        }),
      }),
    }),
  });
  return {
    withTenantDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    ),
    schema: {
      securityEvents: {
        id: "id",
        occurredAt: "occurredAt",
        eventType: "eventType",
        outcome: "outcome",
        actorUserId: "actorUserId",
        orgId: "orgId",
        workspaceId: "workspaceId",
        capability: "capability",
        ip: "ip",
        userAgent: "userAgent",
        requestId: "requestId",
      },
    },
  };
});

vi.mock("@/lib/audit-filters", () => ({
  AUDIT_PAGE_SIZE: 2,
}));

import { queryAuditPage, queryAuditForExport } from "./audit-query";
import type { AuditFilter } from "@/lib/audit-filters";

const baseFilter = {
  eventTypes: [] as string[],
  outcome: null,
  actorUserId: null,
  from: null,
  to: null,
  q: null,
  cursor: null,
} as unknown as AuditFilter;

function row(id: string) {
  return {
    id,
    occurredAt: new Date("2026-06-20T00:00:00.000Z"),
    eventType: "x",
    outcome: "success",
    actorUserId: null,
    orgId: "org-1",
    workspaceId: null,
    capability: null,
    ip: null,
    userAgent: null,
    requestId: null,
  };
}

describe("queryAuditPage (viewer)", () => {
  beforeEach(() => {
    dbState.queue = [];
  });

  it("returns rows + nextCursor when more exist (over-fetch by one)", async () => {
    // pageSize 2 + 1 over-fetch = 3 rows signals hasMore.
    dbState.queue = [[row("a"), row("b"), row("c")]];
    const page = await queryAuditPage("org-1", baseFilter, 2);
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("swallows a DB error into an empty page (viewer must not crash)", async () => {
    dbState.queue = [new Error("connection refused")];
    const page = await queryAuditPage("org-1", baseFilter, 2);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("queryAuditForExport", () => {
  beforeEach(() => {
    dbState.queue = [];
  });

  it("walks all keyset pages and accumulates rows", async () => {
    // Page 1: 3 rows (2 + over-fetch) → hasMore. Page 2: 1 row → done.
    dbState.queue = [[row("a"), row("b"), row("c")], [row("d")]];
    const rows = await queryAuditForExport("org-1", baseFilter);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "d"]);
  });

  it("PROPAGATES a mid-export DB error instead of silently truncating", async () => {
    // Page 1 succeeds (hasMore), page 2 throws — must reject, NOT return ["a","b"].
    dbState.queue = [
      [row("a"), row("b"), row("c")],
      new Error("connection lost"),
    ];
    await expect(queryAuditForExport("org-1", baseFilter)).rejects.toThrow(
      "connection lost",
    );
  });

  it("PROPAGATES a first-page DB error (never returns an empty 'complete' export)", async () => {
    dbState.queue = [new Error("rls denied")];
    await expect(queryAuditForExport("org-1", baseFilter)).rejects.toThrow(
      "rls denied",
    );
  });
});
