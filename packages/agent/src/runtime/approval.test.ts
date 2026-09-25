import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoist the pino warn spy so the vi.mock factory below can reference it safely.
const { pinoWarnSpy } = vi.hoisted(() => ({ pinoWarnSpy: vi.fn() }));

// Stub pino so tests don't need a real logging transport and so we can assert
// the malformed-NOTIFY-payload warning fires.
vi.mock("pino", () => ({
  default: vi.fn(() => ({ warn: pinoWarnSpy, error: vi.fn(), info: vi.fn() })),
}));

// Capture row inserted via the spy chain so the test can assert the shape.
const insertedValues: unknown[] = [];
const executeSpy = vi.fn(async () => undefined);

const returningMock = vi.fn(async () => [
  { id: "appr_123", publicId: "apr_123" },
]);
const valuesMock = vi.fn((v: unknown) => {
  insertedValues.push(v);
  return { returning: returningMock };
});
const insertMock = vi.fn(() => ({ values: valuesMock }));

// Three reads share the fake: the approver fan-out (principals ⨝ assignments
// ⨝ roles), the dedupe read for a live approval on this call, and
// readApproval. The first two are told apart from readApproval by table and
// by projection width — the dedupe read asks for `id` and `publicId` alone.
let approverRows: Array<{ userId: string | null }> = [];
let liveApprovalRows: Array<{ id: string; publicId: string }> = [];
let readApprovalRows: Array<Record<string, unknown>> = [];
let fromTable: unknown = null;
let projectionKeys = 0;
const joinedTables: unknown[] = [];
const whereConds: SQL[] = [];
const limitMock = vi.fn(async () => {
  if (fromTable === schema.principals) return approverRows;
  if (fromTable === schema.approvalRequests)
    return projectionKeys === 2 ? liveApprovalRows : readApprovalRows;
  return [];
});
const whereMock = vi.fn((cond: SQL) => {
  whereConds.push(cond);
  return Object.assign(Promise.resolve([]), { limit: limitMock });
});
const fromMock = vi.fn((table: unknown) => {
  fromTable = table;
  const chain = {
    innerJoin: (joined: unknown) => {
      joinedTables.push(joined);
      return chain;
    },
    where: whereMock,
  };
  return chain;
});
const selectMock = vi.fn((projection?: Record<string, unknown>) => {
  projectionKeys = projection ? Object.keys(projection).length : 0;
  return { from: fromMock };
});

const fakeDb = {
  insert: insertMock,
  select: selectMock,
  execute: executeSpy,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ DATABASE_URL: "postgres://test" }),
}));

// Postgres listen client: capture the handler so we can fire synthetic NOTIFY.
const listenHandlers: Array<(payload: string) => void> = [];
const listenMock = vi.fn(
  async (_channel: string, handler: (p: string) => void) => {
    listenHandlers.push(handler);
  },
);
vi.mock("postgres", () => ({
  default: vi.fn(() => ({ listen: listenMock })),
}));

import { schema } from "@oxagen/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  APPROVAL_NOTIFY_CHUNK,
  APPROVAL_NOTIFY_MAX_RECIPIENTS,
  createApprovalRequest,
  notifyResolution,
  waitForApproval,
  readApproval,
} from "./approval";

describe("approval runtime", () => {
  beforeEach(() => {
    insertedValues.length = 0;
    approverRows = [];
    liveApprovalRows = [];
    readApprovalRows = [{ id: "appr_123", orgId: "ten_1" }];
    fromTable = null;
    projectionKeys = 0;
    joinedTables.length = 0;
    whereConds.length = 0;
    // listenHandlers is intentionally NOT cleared: the NOTIFY listener is a
    // per-process singleton registered exactly once by the first
    // waitForApproval. ensureListener short-circuits on every later call, so the
    // handler is never re-registered — clearing the array would leave later
    // tests (e.g. the malformed-payload case) with no handler to invoke.
    insertMock.mockClear();
    valuesMock.mockClear();
    returningMock.mockClear();
    executeSpy.mockClear();
    selectMock.mockClear();
    whereMock.mockClear();
    pinoWarnSpy.mockClear();
  });

  it("createApprovalRequest inserts row with computed expiresAt", async () => {
    const before = Date.now();
    const res = await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "execute_code",
      inputPreview: { foo: "bar" },
      riskLevel: "high",
      ttlMs: 10_000,
    });
    expect(res.approvalId).toBe("appr_123");
    // The public id rides back with the row id, so a parked call's ledger
    // receipt can name the approval the way Fleet and the Run page show it.
    expect(res.approvalPublicId).toBe("apr_123");
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertedValues[0] as {
      capabilityName: string;
      inputPreview: unknown;
      riskLevel: string;
      expiresAt: Date;
    };
    expect(row.capabilityName).toBe("execute_code");
    expect(row.inputPreview).toEqual({ foo: "bar" });
    expect(row.riskLevel).toBe("high");
    expect(row.expiresAt).toBeInstanceOf(Date);
    const delta = row.expiresAt.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(10_000 - 50);
    expect(delta).toBeLessThanOrEqual(10_000 + 1000);
  });

  it.each([
    ["an approval when the caller names no kind", undefined, "approval"],
    ["a consent request when the consent gate asks", "consent", "consent"],
  ] as const)(
    "records the row's kind: %s (ADR-175)",
    async (_why, kind, recorded) => {
      await createApprovalRequest({
        orgId: "ten_1",
        workspaceId: "ws_1",
        messageId: "msg_1",
        capabilityName: "mcp.1f3b6c22-9d1e-4a55-9d3d-6d1f0c9a2b77.search",
        inputPreview: {},
        riskLevel: "medium",
        ...(kind ? { kind } : {}),
      });
      expect(insertedValues[0]).toMatchObject({ kind: recorded });
    },
  );

  it("createApprovalRequest writes one approval.requested row per person who may resolve it", async () => {
    // One row per qualifying assignment: a person holding both an org and a
    // workspace role appears twice, and is told once.
    approverRows = [
      { userId: "u_owner" },
      { userId: "u_both" },
      { userId: "u_both" },
      { userId: "u_member" },
    ];
    await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "set_budget",
      inputPreview: {},
      riskLevel: "high",
    });
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(insertMock).toHaveBeenLastCalledWith(schema.notifications);
    const rows = insertedValues[1] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.userId)).toEqual([
      "u_owner",
      "u_both",
      "u_member",
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        orgId: "ten_1",
        workspaceId: "ws_1",
        kind: "approval",
        event: "approval.requested",
        title: "Approval requested: set_budget",
      });
    }
  });

  // APPROVAL_RESOLVER_ROLES.workspace is Owner and Member — effectively
  // everyone. An unbounded fan-out writes one row per member inside the
  // approval's transaction, and near 8,000 people it crosses Postgres's
  // 65,535 bind-parameter ceiling and takes the approval down with it.
  it("caps and chunks the fan-out so one approval can never outgrow a statement", async () => {
    approverRows = Array.from(
      { length: APPROVAL_NOTIFY_MAX_RECIPIENTS + 37 },
      (_, i) => ({ userId: `u_${i}` }),
    );
    await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "set_budget",
      inputPreview: {},
      riskLevel: "high",
    });
    const notificationBatches = insertedValues
      .slice(1)
      .map((v) => v as unknown[]);
    expect(notificationBatches.flat()).toHaveLength(
      APPROVAL_NOTIFY_MAX_RECIPIENTS,
    );
    for (const batch of notificationBatches) {
      expect(batch.length).toBeLessThanOrEqual(APPROVAL_NOTIFY_CHUNK);
    }
    // The approval is still written and still resolvable; only the feed is
    // truncated, and the truncation is visible.
    expect(insertedValues[0]).toMatchObject({ capabilityName: "set_budget" });
    expect(pinoWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        notified: APPROVAL_NOTIFY_MAX_RECIPIENTS,
        capabilityName: "set_budget",
      }),
      expect.stringContaining("fan-out truncated"),
    );
  });

  // approvalMode: "park" throws rather than blocking, so the model sees a
  // failed tool call and may ask again for the same call. Without a dedupe
  // each retry writes a fresh approval and another fan-out, and the person is
  // asked to answer the same write several times.
  it("reuses a live approval for the same parked call instead of writing another (negative)", async () => {
    liveApprovalRows = [{ id: "appr_existing", publicId: "apr_existing" }];
    approverRows = [{ userId: "u_owner" }];
    const res = await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "set_budget",
      inputPreview: {},
      riskLevel: "high",
      toolCallId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
    });
    expect(res.approvalId).toBe("appr_existing");
    expect(res.approvalPublicId).toBe("apr_existing");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("keys the dedupe on the call: the turn's message, the capability, the kind and the tool call", async () => {
    await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "set_budget",
      inputPreview: {},
      riskLevel: "high",
      toolCallId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
    });
    const { sql } = new PgDialect().sqlToQuery(whereConds[0]!);
    expect(sql).toMatch(/"approval_requests"\."message_id" = \$\d+/);
    expect(sql).toMatch(/"approval_requests"\."capability_name" = \$\d+/);
    expect(sql).toMatch(/"approval_requests"\."tool_call_id" = \$\d+/);
    // A consent request is never handed back as an approval, or the reverse.
    expect(sql).toMatch(/"approval_requests"\."kind" = \$\d+/);
    // Unresolved and unexpired only: a denied call may be asked again, and an
    // approval past its window is one nobody can answer.
    expect(sql).toMatch(/"approval_requests"\."resolution" is null/);
    expect(sql).toMatch(/"approval_requests"\."expires_at" > \$\d+/);
  });

  it("createApprovalRequest reads recipients the way resolve_approval's gate admits them: active human principals with an unexpired, undeleted IAM assignment of an admitted role (negative: no membership table)", async () => {
    await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "set_budget",
      inputPreview: {},
      riskLevel: "high",
    });
    expect(fromMock).not.toHaveBeenCalledWith(schema.orgUsers);
    expect(fromMock).not.toHaveBeenCalledWith(schema.workspaceUsers);
    expect(fromMock).toHaveBeenCalledWith(schema.principals);
    expect(joinedTables).toEqual([
      schema.principalRoleAssignments,
      schema.roles,
    ]);
    // whereConds[0] is now the dedupe read for a live approval on this call;
    // pick the approver predicate by what it names rather than by position.
    const dialect = new PgDialect();
    const rendered = whereConds.map((c) => dialect.sqlToQuery(c));
    const approverQuery = rendered.find((r) => r.sql.includes('"principals"'));
    expect(approverQuery, "no approver predicate was built").toBeDefined();
    const { sql, params } = approverQuery!;
    // A suspended principal, a service principal, a revoked assignment and
    // an expired one are each excluded by the predicate.
    expect(sql).toMatch(/"principals"\."kind" = \$\d+/);
    expect(sql).toMatch(/"principals"\."status" = \$\d+/);
    expect(sql).toMatch(/"principal_role_assignments"\."deleted_at" is null/);
    expect(sql).toMatch(
      /\("iam"\."principal_role_assignments"\."expires_at" is null or "iam"\."principal_role_assignments"\."expires_at" > \$\d+\)/,
    );
    // Org roles only on org-wide assignments; workspace roles only on this workspace.
    expect(sql).toMatch(/"principal_role_assignments"\."workspace_id" is null/);
    expect(params).toEqual(
      expect.arrayContaining([
        "ten_1",
        "ws_1",
        "human",
        "active",
        "org",
        "workspace",
        "Owner",
        "Admin",
        "Member",
      ]),
    );
    expect(params).not.toContain("Viewer");
  });

  it("createApprovalRequest writes no feed row when nobody may resolve it (negative)", async () => {
    await createApprovalRequest({
      orgId: "ten_1",
      workspaceId: "ws_1",
      messageId: "msg_1",
      capabilityName: "set_budget",
      inputPreview: {},
      riskLevel: "low",
    });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalledWith(schema.notifications);
  });

  it("notifyResolution issues pg_notify on the approval channel", async () => {
    await notifyResolution({
      approvalId: "appr_1",
      resolution: "approved",
      note: null,
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const sqlObj = (
      executeSpy.mock.calls[0] as unknown as [{ queryChunks: unknown[] }]
    )?.[0];
    // The drizzle sql tagged-template produces an object with queryChunks, not a raw string.
    expect(sqlObj).toBeTruthy();
    expect(sqlObj).toHaveProperty("queryChunks");
    // Drizzle sql chunk shape: literal text chunks are { value: string[] },
    // bound parameter chunks are plain strings.
    const chunks = sqlObj!.queryChunks as Array<{ value?: string[] } | string>;
    // Static SQL text (from literal parts) must contain pg_notify.
    const staticText = chunks
      .flatMap((c) =>
        typeof c === "object" && Array.isArray(c.value) ? c.value : [],
      )
      .join("");
    expect(staticText).toContain("pg_notify");
    // Bound params are plain strings — channel name must appear as a param.
    const boundParams = chunks.filter(
      (c): c is string => typeof c === "string",
    );
    expect(boundParams).toContain("agent_approval_resolved");
    // Payload param must contain the approval id and round-trip as JSON.
    const payloadParam = boundParams.find((v) => v.includes("appr_1"));
    expect(payloadParam).toBeTruthy();
    const parsed = JSON.parse(payloadParam!) as {
      approvalId: string;
      resolution: string;
    };
    expect(parsed.approvalId).toBe("appr_1");
    expect(parsed.resolution).toBe("approved");
  });

  it("notifyResolution: hostile note with SQL metacharacters does not corrupt query or payload", async () => {
    const hostileNote = "it's a test; -- ') DROP TABLE approvals; --";
    await notifyResolution({
      approvalId: "appr_hostile",
      resolution: "denied",
      note: hostileNote,
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const sqlObj = (
      executeSpy.mock.calls[0] as unknown as [{ queryChunks: unknown[] }]
    )?.[0];
    expect(sqlObj).toHaveProperty("queryChunks");
    const chunks = sqlObj!.queryChunks as Array<{ value?: string[] } | string>;
    // Static SQL text (literal parts) must NOT contain any hostile content.
    const staticText = chunks
      .flatMap((c) =>
        typeof c === "object" && Array.isArray(c.value) ? c.value : [],
      )
      .join("");
    expect(staticText).not.toContain(hostileNote);
    expect(staticText).not.toContain("DROP TABLE");
    // Payload is a plain-string bound parameter — find it and verify it round-trips.
    const boundParams = chunks.filter(
      (c): c is string => typeof c === "string",
    );
    const payloadParam = boundParams.find((v) => v.includes("appr_hostile"));
    expect(payloadParam).toBeTruthy();
    const parsed = JSON.parse(payloadParam!) as {
      approvalId: string;
      resolution: string;
      note: string;
    };
    expect(parsed.approvalId).toBe("appr_hostile");
    expect(parsed.resolution).toBe("denied");
    // note is preserved exactly — including every hostile character — without escaping or truncation.
    expect(parsed.note).toBe(hostileNote);
  });

  it("waitForApproval resolves on NOTIFY for the matching id", async () => {
    const promise = waitForApproval("appr_wait_1", 60_000);
    // Allow ensureListener to register the handler.
    await new Promise((r) => setTimeout(r, 0));
    const handler = listenHandlers[listenHandlers.length - 1]!;
    handler(
      JSON.stringify({
        approvalId: "appr_wait_1",
        resolution: "approved",
        note: null,
      }),
    );
    const res = await promise;
    expect(res.approvalId).toBe("appr_wait_1");
    expect(res.resolution).toBe("approved");
  });

  it("waitForApproval times out as expired after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const promise = waitForApproval("appr_timeout_1", 5_000);
      // Flush any synchronous microtasks (listener already started).
      await Promise.resolve();
      vi.advanceTimersByTime(5_001);
      const res = await promise;
      expect(res.resolution).toBe("expired");
      expect(res.approvalId).toBe("appr_timeout_1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("malformed NOTIFY payload logs a warn and does NOT resolve the waiter", async () => {
    // Register a waiter so we can confirm a corrupt payload does not resolve it.
    const promise = waitForApproval("appr_malformed", 60_000);
    // Allow ensureListener to register the handler.
    await new Promise((r) => setTimeout(r, 0));
    const handler = listenHandlers[listenHandlers.length - 1]!;

    // Fire a corrupt payload that will fail JSON.parse.
    handler("this is not json {{{");

    // The warn logger must have been called with the corrupt payload.
    expect(pinoWarnSpy).toHaveBeenCalledTimes(1);
    const [meta, msg] = pinoWarnSpy.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toContain("malformed NOTIFY payload");
    expect(meta).toHaveProperty("payload", "this is not json {{{");
    expect(meta).toHaveProperty("err");

    // The waiter must NOT be resolved by the corrupt payload — it stays pending.
    const raceResult = await Promise.race([
      promise.then(() => "resolved" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(raceResult).toBe("pending");

    // Drain the still-pending waiter with a VALID NOTIFY so the promise settles.
    // (The TTL timer was scheduled under real timers when waitForApproval was
    // called, so switching to fake timers and advancing them would never fire it
    // — that mismatch would hang the test.) The lingering real TTL timer is a
    // harmless no-op once the waiter has been deleted by this resolution.
    handler(
      JSON.stringify({
        approvalId: "appr_malformed",
        resolution: "denied",
        note: null,
      }),
    );
    const res = await promise;
    expect(res.resolution).toBe("denied");
  });

  it("readApproval shapes select with id + orgId filters", async () => {
    const row = await readApproval("appr_1", "ten_1");
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledTimes(1);
    expect(row).toEqual({ id: "appr_123", orgId: "ten_1" });
  });
});
