// security.test.ts
//
// Unit tests for makeSecurityEventInserter() from @oxagen/database/security.
//
// Key invariant: the inserter MUST use withSystemDb (the RLS bypass) rather
// than withTenantDb. This is the audit-safety property — security events must
// be writable even when there is no active tenant scope (e.g. a
// capability.invoke_denied that fires before a scope is established).

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before any imports so vi.mock() calls are hoisted.
// ---------------------------------------------------------------------------

interface MockTx {
  insert: (table: unknown) => { values: (vals: unknown) => Promise<void> };
}

const mocks = vi.hoisted(() => {
  const insertValues = vi.fn(async () => undefined);
  const insert = vi.fn((_table: unknown) => ({ values: insertValues }));
  const tx: MockTx = { insert };

  const withSystemDb = vi.fn(
    async <T>(fn: (tx: MockTx) => Promise<T>): Promise<T> => fn(tx),
  );
  // withTenantDb must NEVER be called by makeSecurityEventInserter.
  const withTenantDb = vi.fn(async () => {
    throw new Error(
      "withTenantDb must NOT be called by makeSecurityEventInserter — " +
        "audit writes require withSystemDb to bypass RLS",
    );
  });

  return { withSystemDb, withTenantDb, insert, insertValues, tx };
});

vi.mock("./tenant", () => ({
  withSystemDb: mocks.withSystemDb,
  withTenantDb: mocks.withTenantDb,
}));

vi.mock("./index", () => ({
  schema: {
    securityEvents: { _: "securityEventsMock" },
  },
}));

import { makeSecurityEventInserter } from "./security";
import type { SecurityEventInput } from "@oxagen/telemetry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_EVENT: SecurityEventInput = {
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  eventType: "capability.invoke_denied",
  actorUserId: "00000000-0000-0000-0000-000000000001",
  orgId: "00000000-0000-0000-0000-000000000002",
  workspaceId: "00000000-0000-0000-0000-000000000003",
  capability: "billing.createCheckout",
  outcome: "deny",
  ip: "1.2.3.4",
  userAgent: "Mozilla/5.0",
  requestId: "req_abc123",
};

beforeEach(() => {
  mocks.withSystemDb.mockClear();
  mocks.withTenantDb.mockClear();
  mocks.insert.mockClear();
  mocks.insertValues.mockClear();
});

// ---------------------------------------------------------------------------
// Core invariant: uses withSystemDb, never withTenantDb
// ---------------------------------------------------------------------------

describe("makeSecurityEventInserter — RLS bypass invariant", () => {
  it("calls withSystemDb (not withTenantDb) for the insert", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter(BASE_EVENT);

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("works WITHOUT any active tenant scope (no requireScope, no TenantScopeError)", async () => {
    // There is no runInTenantScope wrapper here — withSystemDb must not require one.
    const inserter = makeSecurityEventInserter();
    // Must not throw
    await expect(inserter(BASE_EVENT)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Values mapping: null → undefined (Drizzle convention x ?? undefined)
// ---------------------------------------------------------------------------

describe("makeSecurityEventInserter — null field mapping", () => {
  it("maps null actorUserId to undefined", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter({ ...BASE_EVENT, actorUserId: null });

    const callArg = (
      mocks.insertValues.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect(callArg.actorUserId).toBeUndefined();
  });

  it("maps null workspaceId to undefined", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter({ ...BASE_EVENT, workspaceId: null });

    const callArg = (
      mocks.insertValues.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect(callArg.workspaceId).toBeUndefined();
  });

  it("maps null capability to undefined", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter({ ...BASE_EVENT, capability: null });

    const callArg = (
      mocks.insertValues.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect(callArg.capability).toBeUndefined();
  });

  it("maps null ip to undefined", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter({ ...BASE_EVENT, ip: null });

    const callArg = (
      mocks.insertValues.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect(callArg.ip).toBeUndefined();
  });

  it("maps null userAgent to undefined", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter({ ...BASE_EVENT, userAgent: null });

    const callArg = (
      mocks.insertValues.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect(callArg.userAgent).toBeUndefined();
  });

  it("maps null requestId to undefined", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter({ ...BASE_EVENT, requestId: null });

    const callArg = (
      mocks.insertValues.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect(callArg.requestId).toBeUndefined();
  });

  it("passes non-null values through unchanged", async () => {
    const inserter = makeSecurityEventInserter();
    await inserter(BASE_EVENT);

    const callArg = (
      mocks.insertValues.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(callArg).toBeDefined();
    expect(callArg.actorUserId).toBe(BASE_EVENT.actorUserId);
    expect(callArg.workspaceId).toBe(BASE_EVENT.workspaceId);
    expect(callArg.capability).toBe(BASE_EVENT.capability);
    expect(callArg.ip).toBe(BASE_EVENT.ip);
    expect(callArg.userAgent).toBe(BASE_EVENT.userAgent);
    expect(callArg.requestId).toBe(BASE_EVENT.requestId);
  });
});

// ---------------------------------------------------------------------------
// Returned fn is AuditInsertFn: (event) => Promise<void>
// ---------------------------------------------------------------------------

describe("makeSecurityEventInserter — return type", () => {
  it("returns a function", () => {
    expect(makeSecurityEventInserter()).toBeTypeOf("function");
  });

  it("the returned function resolves void (not a value)", async () => {
    const inserter = makeSecurityEventInserter();
    const result = await inserter(BASE_EVENT);
    expect(result).toBeUndefined();
  });

  it("creates independent inserter instances per call", () => {
    const a = makeSecurityEventInserter();
    const b = makeSecurityEventInserter();
    expect(a).not.toBe(b);
  });
});
