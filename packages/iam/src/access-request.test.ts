// access-request.test.ts — unit tests for createAccessRequest() (OXA-1524).
//
// Tests:
//   - null principal → returns null (graceful degradation)
//   - Successful insert → returns publicId
//   - DB error → returns null (graceful degradation)
//   - Idempotency: an existing pending request is returned, no duplicate insert
//   - Scope derivation (org vs workspace)

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  insertFn: vi.fn(),
  selectFn: vi.fn(),
  dbFn: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: mocks.dbFn,
    // withTenantDb: pass-through — invokes the callback with the same fake tx
    // the handler expects. No scope GUC overhead in unit tests (OXA-1515).
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mocks.dbFn()),
  };
});

import { createAccessRequest } from "./access-request";
import type { CapabilityContext, ResolvedPrincipal } from "@oxagen/oxagen";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_ar_test",
  workspaceId: "ws_ar_test",
  userId: "usr_ar_test",
  apiKeyId: null,
  requestId: "req_ar_test",
  surface: "api",
  messageId: null,
};

const PRINCIPAL: ResolvedPrincipal = {
  id: "prn_ar_test",
  kind: "human",
  orgId: "org_ar_test",
  workspaceId: "ws_ar_test",
};

// Build the select().from().where().limit() chain the dedup lookup calls,
// resolving to `rows`. Defaults to no existing pending request.
function stubExistingPending(rows: Array<{ publicId: string }>): void {
  mocks.selectFn.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createAccessRequest()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing pending request → the insert path runs.
    stubExistingPending([]);
    mocks.dbFn.mockReturnValue({
      select: mocks.selectFn,
      insert: mocks.insertFn,
    });
  });

  // ── null principal → null ────────────────────────────────────────────────

  it("returns null when principal is null (graceful degradation — IAM tables may not exist)", async () => {
    const result = await createAccessRequest({
      capability: "send_message",
      ctx: CTX,
      principal: null,
    });

    expect(result).toBeNull();
    // No DB call should be made.
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  // ── Successful insert → publicId ─────────────────────────────────────────

  it("inserts an access_request row and returns its publicId", async () => {
    mocks.insertFn.mockReturnValue({
      values: () => ({
        returning: () => Promise.resolve([{ publicId: "arq_test_123" }]),
      }),
    });

    const result = await createAccessRequest({
      capability: "send_message",
      ctx: CTX,
      principal: PRINCIPAL,
      justification: "need access for demo",
    });

    expect(result).toBe("arq_test_123");
    expect(mocks.insertFn).toHaveBeenCalledTimes(1);
  });

  it("returns null when the insert returns an empty array (row missing)", async () => {
    mocks.insertFn.mockReturnValue({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    });

    const result = await createAccessRequest({
      capability: "send_message",
      ctx: CTX,
      principal: PRINCIPAL,
    });

    expect(result).toBeNull();
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it("returns the existing pending request's publicId without inserting a duplicate", async () => {
    // A pending request already exists for this (org, requester, capability, scope).
    stubExistingPending([{ publicId: "arq_existing_1" }]);

    const result = await createAccessRequest({
      capability: "send_message",
      ctx: CTX,
      principal: PRINCIPAL,
    });

    expect(result).toBe("arq_existing_1");
    // The dedup short-circuits before the insert — no duplicate row.
    expect(mocks.insertFn).not.toHaveBeenCalled();
  });

  // ── DB error → null ──────────────────────────────────────────────────────

  it("returns null when the DB insert throws (graceful degradation)", async () => {
    mocks.insertFn.mockReturnValue({
      values: () => ({
        returning: () => Promise.reject(new Error("connection refused")),
      }),
    });

    const result = await createAccessRequest({
      capability: "send_message",
      ctx: CTX,
      principal: PRINCIPAL,
    });

    expect(result).toBeNull();
  });

  // ── Scope derivation ─────────────────────────────────────────────────────

  it("uses workspace scope when workspaceId is present in ctx", async () => {
    let capturedValues: Record<string, unknown> | undefined;

    mocks.insertFn.mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedValues = vals;
        return {
          returning: () => Promise.resolve([{ publicId: "arq_ws_scope" }]),
        };
      },
    });

    await createAccessRequest({
      capability: "send_message",
      ctx: { ...CTX, workspaceId: "ws_scope_test" },
      principal: PRINCIPAL,
    });

    expect(capturedValues?.scopeKind).toBe("workspace");
    expect(capturedValues?.scopeId).toBe("ws_scope_test");
  });

  it("uses org scope when workspaceId is empty", async () => {
    let capturedValues: Record<string, unknown> | undefined;

    mocks.insertFn.mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedValues = vals;
        return {
          returning: () => Promise.resolve([{ publicId: "arq_org_scope" }]),
        };
      },
    });

    await createAccessRequest({
      capability: "send_message",
      ctx: { ...CTX, workspaceId: "" },
      principal: PRINCIPAL,
    });

    expect(capturedValues?.scopeKind).toBe("org");
    expect(capturedValues?.scopeId).toBe("org_ar_test");
  });

  it("uses org scope when workspaceId is null — distinct from the empty-string case", async () => {
    // ctx.workspaceId = null (not "") — the falsy check `ctx.workspaceId ? "workspace" : "org"`
    // resolves to "org" and scopeId must equal orgId.
    let capturedValues: Record<string, unknown> | undefined;

    mocks.insertFn.mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedValues = vals;
        return {
          returning: () => Promise.resolve([{ publicId: "arq_null_ws_scope" }]),
        };
      },
    });

    // TypeScript's CapabilityContext types workspaceId as string | null.
    const ctxNullWs: CapabilityContext = {
      ...CTX,
      workspaceId: null as unknown as string,
    };

    await createAccessRequest({
      capability: "send_message",
      ctx: ctxNullWs,
      principal: PRINCIPAL,
    });

    expect(capturedValues?.scopeKind).toBe("org");
    expect(capturedValues?.scopeId).toBe("org_ar_test");
  });
});
