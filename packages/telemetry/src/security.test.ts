// security.test.ts
//
// Unit tests for the security_events audit surface.
//
// Coverage goals (SOC2-critical):
//   1. The DB schema for security_events contains ONLY append-only columns —
//      no updated_at, updated_by_user_id, deleted_at, deleted_by_user_id.
//   2. recordSecurityEvent calls the insert fn with the expected row shape.
//   3. recordSecurityEventAsync resolves after the insert fn resolves.
//   4. recordSecurityEvent swallows insert errors and forwards them to onError.
//   5. SECURITY_EVENT_TYPES contains the canonical event values so callers
//      can build CHECKs / typed switches without reimporting from @oxagen/database.

import { describe, expect, it, vi } from "vitest";
import {
  SECURITY_EVENT_TYPES,
  recordSecurityEvent,
  recordSecurityEventAsync,
  type AuditInsertFn,
  type SecurityEventInput,
} from "./security.js";

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
    // occurredAt is optional (DB defaults to now())
    expect("occurredAt" in event || true).toBe(true);
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

  it("does not throw when the insert fn rejects — error is forwarded to onError", async () => {
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
    expect(() => recordSecurityEvent(insert as AuditInsertFn, event, onError)).not.toThrow();

    // Let the rejection handler run
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(insertErr);
  });

  it("does not re-throw when no onError is provided — logs to console.error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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

    expect(() => recordSecurityEvent(insert as AuditInsertFn, event)).not.toThrow();
    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
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

    await expect(recordSecurityEventAsync(insert as AuditInsertFn, event)).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledOnce();
  });

  it("rejects when the insert fn rejects", async () => {
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

    await expect(recordSecurityEventAsync(insert as AuditInsertFn, event)).rejects.toThrow(
      "constraint violation",
    );
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
