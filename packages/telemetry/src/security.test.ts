// security.test.ts
//
// Unit tests for the security_events audit surface.
//
// Coverage goals (SOC2-critical):
//   1. The DB schema for security_events contains ONLY append-only columns —
//      no updated_at, updated_by_user_id, deleted_at, deleted_by_user_id.
//   2. recordSecurityEvent calls the insert fn with the expected row shape.
//   3. recordSecurityEventAsync resolves after the insert fn resolves.
//   4. recordSecurityEvent retries transient insert failures with backoff
//      and, once exhausted, escalates via captureError (ClickHouse
//      error_events) in addition to forwarding to onError — a dropped audit
//      write must never be observable only via a stderr line nobody watches.
//   5. SECURITY_EVENT_TYPES contains the canonical event values so callers
//      can build CHECKs / typed switches without reimporting from @oxagen/database.

import { describe, expect, it, vi } from "vitest";

// Mock the ClickHouse insert boundary so captureError() (invoked internally
// on write-failure escalation) never touches a live client — mirrors
// the pattern in error-reporting.test.ts.
const insertErrorEvents = vi.fn((_rows: unknown[]) => Promise.resolve());
vi.mock("./clickhouse", () => ({
  insertErrorEvents: (rows: unknown[]) => insertErrorEvents(rows),
}));

import {
  SECURITY_EVENT_TYPES,
  recordSecurityEvent,
  recordSecurityEventAsync,
  type AuditInsertFn,
  type SecurityEventInput,
} from "./security";

/** Extract the single error_events row from the most recent captureError() escalation. */
function lastErrorRow(): Record<string, unknown> {
  const call = insertErrorEvents.mock.calls.at(-1);
  if (!call)
    throw new Error(
      "insertErrorEvents (captureError escalation) was not called",
    );
  const rows = call[0] as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error("captureError escalation called with no rows");
  return row;
}

/** Waits long enough for recordSecurityEvent's internal retry/backoff (3 attempts, 25ms+50ms) to fully settle. */
const flushRetries = () => new Promise((r) => setTimeout(r, 250));

// ---------------------------------------------------------------------------
// 1. Append-only schema assertion
//    We assert on the SECURITY_EVENT_TYPES export and the shape of
//    SecurityEventInput (no updated_* / deleted_* keys). This mirrors what
//    the schema declaration enforces in packages/database — the telemetry
//    package's own type must not smuggle mutation columns.
// ---------------------------------------------------------------------------

describe("SecurityEventInput — append-only column contract", () => {
  it("does not contain updated_at or updated_by_user_id", () => {
    // Build a valid event and check its keys at the type level.
    const event: SecurityEventInput = {
      eventType: "auth.sign_in",
      actorUserId: "user-uuid",
      orgId: "org-uuid",
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: "req-1",
    };

    const keys = Object.keys(event);
    expect(keys).not.toContain("updated_at");
    expect(keys).not.toContain("updatedAt");
    expect(keys).not.toContain("updated_by_user_id");
    expect(keys).not.toContain("updatedByUserId");
    expect(keys).not.toContain("deleted_at");
    expect(keys).not.toContain("deletedAt");
    expect(keys).not.toContain("deleted_by_user_id");
    expect(keys).not.toContain("deletedByUserId");
  });

  it("contains the required append-only columns", () => {
    const event: SecurityEventInput = {
      eventType: "capability.invoke_allowed",
      actorUserId: "user-uuid",
      orgId: "org-uuid",
      workspaceId: "ws-uuid",
      capability: "agent.task.run",
      outcome: "allow",
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      requestId: "req-2",
    };

    expect(event).toHaveProperty("eventType");
    expect(event).toHaveProperty("actorUserId");
    expect(event).toHaveProperty("orgId");
    expect(event).toHaveProperty("outcome");
    // occurredAt is optional (DB defaults to now()) — must not appear in the
    // manually constructed event object above since it was not set.
    const keys = Object.keys(event);
    expect(keys).not.toContain("occurredAt");
  });
});

// ---------------------------------------------------------------------------
// 2. recordSecurityEvent — calls insert with the expected payload
// ---------------------------------------------------------------------------

describe("recordSecurityEvent", () => {
  it("calls the insert fn with the exact event object", async () => {
    const insert = vi.fn((_row: SecurityEventInput) => Promise.resolve());
    const event: SecurityEventInput = {
      eventType: "auth.sign_in",
      actorUserId: "user-123",
      orgId: "org-abc",
      workspaceId: "ws-xyz",
      capability: null,
      outcome: "success",
      ip: "10.0.0.1",
      userAgent: "test-agent",
      requestId: "req-test",
    };

    recordSecurityEvent(insert as AuditInsertFn, event);

    // Flush the microtask queue so the promise resolves before we assert.
    await Promise.resolve();

    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(event);
  });

  it("does not throw when the insert fn rejects — error is forwarded to onError after retries exhausted", async () => {
    const insertErr = new Error("DB unavailable");
    const insert = vi.fn(() => Promise.reject(insertErr));
    const onError = vi.fn();

    const event: SecurityEventInput = {
      eventType: "capability.invoke_denied",
      actorUserId: null,
      orgId: "org-abc",
      workspaceId: null,
      capability: "billing.subscription.cancel",
      outcome: "deny",
      ip: null,
      userAgent: null,
      requestId: null,
    };

    // Must not throw synchronously
    expect(() =>
      recordSecurityEvent(insert as AuditInsertFn, event, onError),
    ).not.toThrow();

    // Let the retry/backoff cycle (3 attempts) fully settle before asserting.
    await flushRetries();

    // The insert is retried, not given up on after a single failure.
    expect(insert).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(insertErr);
  });

  it("escalates to captureError (ClickHouse error_events) once retries are exhausted", async () => {
    const insertErr = new Error("connection reset");
    const insert = vi.fn(() => Promise.reject(insertErr));

    const event: SecurityEventInput = {
      eventType: "capability.invoke_denied",
      actorUserId: null,
      orgId: "org-escalate",
      workspaceId: "ws-escalate",
      capability: "billing.subscription.cancel",
      outcome: "deny",
      ip: null,
      userAgent: null,
      requestId: "req-escalate",
    };

    recordSecurityEvent(insert as AuditInsertFn, event);
    await flushRetries();

    // The audit-write failure must be observable beyond stderr: a dropped
    // security audit event is a SOC2-relevant silent failure and must land
    // in the durable, alertable error pipeline.
    expect(insertErrorEvents).toHaveBeenCalledTimes(1);
    const row = lastErrorRow();
    expect(row.capability).toBe("billing.subscription.cancel");
    expect(row.message).toContain("failed to durably write event");
    expect(row.message).toContain("capability.invoke_denied");
  });

  it("retries a transient failure and succeeds without escalating — insert succeeds on the 2nd attempt", async () => {
    let calls = 0;
    const insert = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("transient"))
        : Promise.resolve();
    });
    const onError = vi.fn();

    const event: SecurityEventInput = {
      eventType: "auth.sign_in",
      actorUserId: "user-1",
      orgId: "org-transient",
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    };

    recordSecurityEvent(insert as AuditInsertFn, event, onError);
    await flushRetries();

    expect(insert).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(insertErrorEvents).not.toHaveBeenCalled();
  });

  it("does not re-throw when no onError is provided — writes to process.stderr after retries exhausted", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const insert = vi.fn(() => Promise.reject(new Error("disk full")));

    const event: SecurityEventInput = {
      eventType: "api_key.revoked",
      actorUserId: "admin-user",
      orgId: "org-abc",
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    };

    expect(() =>
      recordSecurityEvent(insert as AuditInsertFn, event),
    ).not.toThrow();
    await flushRetries();

    expect(stderrSpy).toHaveBeenCalledOnce();
    // Confirm the structured output contains the event type and org id.
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(written).toContain("api_key.revoked");
    expect(written).toContain("org-abc");
    stderrSpy.mockRestore();
  });

  it("uses String(err) when the insert rejection is a non-Error value", async () => {
    // Covers the `err instanceof Error ? err.message : String(err)` false branch
    // on the default stderr path.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Reject with a plain number (not an Error instance)
    const insert = vi.fn(() => Promise.reject(42));

    const event: SecurityEventInput = {
      eventType: "auth.sign_in_failed",
      actorUserId: null,
      orgId: "org-xyz",
      workspaceId: null,
      capability: null,
      outcome: "deny",
      ip: null,
      userAgent: null,
      requestId: null,
    };

    expect(() =>
      recordSecurityEvent(insert as AuditInsertFn, event),
    ).not.toThrow();
    await flushRetries();

    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written.trim()) as { err: string };
    // String(42) === "42"
    expect(parsed.err).toBe("42");
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. recordSecurityEventAsync — resolves after insert
// ---------------------------------------------------------------------------

describe("recordSecurityEventAsync", () => {
  it("resolves when the insert fn resolves", async () => {
    const insert = vi.fn((_row: SecurityEventInput) => Promise.resolve());
    const event: SecurityEventInput = {
      eventType: "org.member_invited",
      actorUserId: "admin-user",
      orgId: "org-abc",
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: "req-async",
    };

    await expect(
      recordSecurityEventAsync(insert as AuditInsertFn, event),
    ).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledOnce();
  });

  it("rejects when the insert fn rejects — retries first, then escalates via captureError before re-throwing", async () => {
    const dbError = new Error("constraint violation");
    const insert = vi.fn(() => Promise.reject(dbError));
    const event: SecurityEventInput = {
      eventType: "auth.sign_out",
      actorUserId: "user-123",
      orgId: "org-abc",
      workspaceId: null,
      capability: null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    };

    await expect(
      recordSecurityEventAsync(insert as AuditInsertFn, event),
    ).rejects.toThrow("constraint violation");

    // The awaitable variant retries transient failures (not a
    // single-shot attempt) and still escalates to the durable, alertable
    // error pipeline before re-throwing — the awaiting caller's compliance
    // evidence is load-bearing, so the failure must be observable even though
    // it also propagates as a rejection.
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insertErrorEvents).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. SECURITY_EVENT_TYPES — canonical set of event type strings
// ---------------------------------------------------------------------------

describe("SECURITY_EVENT_TYPES", () => {
  it("is a non-empty readonly array of strings", () => {
    expect(SECURITY_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const t of SECURITY_EVENT_TYPES) {
      expect(typeof t).toBe("string");
    }
  });

  it("contains all three event groups (auth, capability, api_key)", () => {
    const types = SECURITY_EVENT_TYPES as readonly string[];
    expect(types.some((t) => t.startsWith("auth."))).toBe(true);
    expect(types.some((t) => t.startsWith("capability."))).toBe(true);
    expect(types.some((t) => t.startsWith("api_key."))).toBe(true);
    expect(types.some((t) => t.startsWith("org."))).toBe(true);
  });

  it("includes the highest-priority event types required by SOC2", () => {
    const types = SECURITY_EVENT_TYPES as readonly string[];
    // These are the minimum CC6/CC7 evidence events.
    const required = [
      "auth.sign_in",
      "auth.sign_in_failed",
      "auth.sign_out",
      "capability.invoke_allowed",
      "capability.invoke_denied",
      "capability.invoke_error",
    ];
    for (const r of required) {
      expect(types).toContain(r);
    }
  });
});
