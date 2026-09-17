/**
 * audit-query.test.ts — unit tests for queryAuditPage / queryAuditForExport.
 *
 * Regression for the silent-truncation fix: the VIEWER path may swallow a DB
 * error into an empty page (renders without crashing), but the EXPORT path must
 * PROPAGATE the error — otherwise a mid-export failure would be HMAC-signed as a
 * complete-but-truncated SOC 2 evidence file, an undetectable gap.
 *
 * And the truncation those tests could not see. `security.security_events` is
 * policy class `workspace_nullable`, so read under the org-only workspace
 * sentinel its RLS policy admits only the rows whose workspace_id IS NULL —
 * which excludes the kernel's own capability.invoke_* envelopes, secret.reveal,
 * plugin.credential.* and tacho.enrollment.*, every one of which carries a real
 * workspace. RLS hides rather than refuses, so the error-propagation tests above
 * stayed green while the signed export was short. The `withSystemDb` mock below
 * is deliberately the ONLY seam that answers: a read that goes back to
 * `withTenantDb` gets undefined and fails here rather than in a customer's
 * compliance file.
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    withSystemDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    ),
    // Present but inert: if the read seam regresses to the tenant-scoped one,
    // every assertion below fails on `undefined` instead of passing quietly.
    withTenantDb: vi.fn(() => undefined),
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
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@/lib/audit-filters", () => ({
  AUDIT_PAGE_SIZE: 2,
}));

import {
  assertOrgFenced,
  queryAuditPage,
  queryAuditForExport,
} from "./audit-query";
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

function row(id: string, workspaceId: string | null = null) {
  return {
    id,
    occurredAt: new Date("2026-06-20T00:00:00.000Z"),
    eventType: "x",
    outcome: "success",
    actorUserId: null,
    orgId: "org-1",
    workspaceId,
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

describe("the org-level read is not narrowed by the workspace sentinel", () => {
  beforeEach(() => {
    dbState.queue = [];
  });

  it("exports the workspace-scoped events, which are most of the record", async () => {
    // Exactly the shape RLS used to drop: the kernel emits its allow/deny
    // envelope with ctx.workspaceId, and only the org-wide rows survived a
    // tenant-scoped read under the sentinel.
    // AUDIT_PAGE_SIZE is 2 here, so the third row is the over-fetch marker and
    // the walk asks for a second page.
    dbState.queue = [
      [row("org-wide", null), row("in-ws", "ws-1"), row("in-other-ws", "ws-2")],
      [row("in-other-ws", "ws-2")],
    ];
    const rows = await queryAuditForExport("org-1", baseFilter);
    expect(rows.map((r) => r.id)).toEqual(["org-wide", "in-ws", "in-other-ws"]);
    expect(rows.filter((r) => r.workspaceId !== null)).toHaveLength(2);
  });

  it("shows the viewer the same workspace-scoped events it will export", async () => {
    dbState.queue = [[row("org-wide", null), row("in-ws", "ws-1")]];
    const page = await queryAuditPage("org-1", baseFilter, 10);
    expect(page.rows.map((r) => r.workspaceId)).toEqual([null, "ws-1"]);
  });

  it("reads through the system seam, never the tenant-scoped one", async () => {
    const { withSystemDb, withTenantDb } = await import("@oxagen/database");
    dbState.queue = [[row("a")]];
    await queryAuditPage("org-1", baseFilter, 10);
    expect(withSystemDb).toHaveBeenCalled();
    expect(withTenantDb).not.toHaveBeenCalled();
  });
});

describe("assertOrgFenced", () => {
  it("passes rows that all carry the org asked for", () => {
    expect(() =>
      assertOrgFenced([row("a"), row("b", "ws-1")], "org-1"),
    ).not.toThrow();
  });

  it("refuses a foreign-org row rather than rendering or signing it", () => {
    // The org fence is application code now, not a database policy, so a
    // regression in buildConditions widens the read instead of narrowing it.
    expect(() =>
      assertOrgFenced([{ ...row("a"), orgId: "org-2" }], "org-1"),
    ).toThrow(/org fence/i);
  });

  it("is applied to every page the export walks", async () => {
    dbState.queue = [
      [row("a"), row("b"), row("c")],
      [{ ...row("d"), orgId: "org-2" }],
    ];
    await expect(queryAuditForExport("org-1", baseFilter)).rejects.toThrow(
      /org fence/i,
    );
  });
});

describe("the export refuses to sign a prefix", () => {
  beforeEach(() => {
    dbState.queue = [];
  });

  it("throws when the record is longer than maxRows", async () => {
    // maxRows 2, page size 2: the first page over-fetches to 3 and reports a
    // next cursor, so the loop has a page still to come when it hits the cap.
    dbState.queue = [[row("a"), row("b"), row("c")]];
    await expect(queryAuditForExport("org-1", baseFilter, 2)).rejects.toThrow(
      /exceeds 2 events/,
    );
  });

  it("returns normally when the record ends within maxRows", async () => {
    dbState.queue = [[row("a"), row("b")]];
    const rows = await queryAuditForExport("org-1", baseFilter, 2);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
