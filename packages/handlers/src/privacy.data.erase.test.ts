/**
 * Unit tests for the privacy.data.erase handler (GDPR Art. 17 — right to erasure).
 *
 * Mocks:
 *   - @oxagen/database          → withSystemDb (routes to a fluent tx mock); schema kept real
 *   - @oxagen/database/security → emitSecurityEvent
 *   - ./event-client            → eventClient.send (async Inngest dispatch)
 *   - ./logger                  → logger.info
 *
 * Scenarios:
 *   1. No authenticated user            → throws Unauthorized
 *   2. No orgId in context              → throws Forbidden
 *   3. org scope without input.orgId    → throws (orgId required)
 *   4. org scope, lowercase "owner"     → SUCCEEDS  ← regression guard for the
 *      "Owner" vs "owner" case bug that blocked every legitimate owner.
 *   5. org scope, non-owner ("admin")   → throws Forbidden
 *   6. org scope, no membership row     → throws Forbidden (IDOR guard)
 *   7. user scope                       → SUCCEEDS without any role check, revokes
 *      sessions, emits security event + Inngest job, returns queued.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// Narrow shapes for the mocked call args we assert on (avoids `any` while
// staying robust under noUncheckedIndexedAccess via `.at()`).
type EmittedEvent = { eventType: string };
type InngestEvent = { name: string; data: { scope: string } };
const firstArg = <T>(fn: { mock: { calls: unknown[][] } }): T | undefined =>
  fn.mock.calls.at(0)?.at(0) as T | undefined;

// ── @oxagen/database/security mock ───────────────────────────────────────────
const mockEmitSecurityEvent = vi.fn();
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mockEmitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

// ── ./event-client mock (async Inngest dispatch) ─────────────────────────────
const mockEventSend = vi.fn().mockResolvedValue(undefined);
vi.mock("./event-client", () => ({
  eventClient: { send: mockEventSend },
}));

// ── ./logger mock ────────────────────────────────────────────────────────────
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── @oxagen/database mock ────────────────────────────────────────────────────
// A single fluent tx object services every chain the handler builds:
//   select().from().where().limit()           → roleResult
//   insert().values().returning()              → insertResult
//   delete().where()                           → awaited & ignored
// `where` returns the tx so it works both mid-chain (before .limit) and as the
// terminal of the session delete (await of a plain object resolves to itself).
let roleResult: Array<{ role: string }> = [];
const insertResult = [{ id: "11111111-1111-4111-8111-111111111111" }];

const tx = {
  select: vi.fn(() => tx),
  from: vi.fn(() => tx),
  where: vi.fn(() => tx),
  limit: vi.fn(() => Promise.resolve(roleResult)),
  insert: vi.fn(() => tx),
  values: vi.fn(() => tx),
  returning: vi.fn(() => Promise.resolve(insertResult)),
  delete: vi.fn(() => tx),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: (fn: (t: typeof tx) => unknown) => fn(tx),
  };
});

const { privacyDataEraseHandler } = await import("./privacy.data.erase");

// ── Helpers ──────────────────────────────────────────────────────────────────
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function makeCtx(
  overrides: Partial<CapabilityContext> = {},
): CapabilityContext {
  return {
    userId: "user-1",
    apiKeyId: null,
    orgId: ORG_ID,
    workspaceId: "ws-1",
    surface: "api",
    requestId: "req-1",
    messageId: null,
    ...overrides,
  } as CapabilityContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  roleResult = [];
  // Deterministic effectiveAt and immediate-erasure path for assertions.
  process.env.PRIVACY_ERASURE_GRACE_DAYS = "0";
});

describe("privacy.data.erase handler", () => {
  it("throws Unauthorized when no authenticated user", async () => {
    await expect(
      privacyDataEraseHandler(
        { scope: "user", confirm: true },
        makeCtx({ userId: undefined }),
      ),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("throws Forbidden when no orgId in context", async () => {
    await expect(
      privacyDataEraseHandler(
        { scope: "user", confirm: true },
        makeCtx({ orgId: undefined }),
      ),
    ).rejects.toThrow(/Forbidden/);
  });

  it("throws when org scope is missing input.orgId", async () => {
    await expect(
      privacyDataEraseHandler({ scope: "org", confirm: true }, makeCtx()),
    ).rejects.toThrow(/orgId is required/);
  });

  it("REGRESSION: org scope succeeds for a lowercase 'owner' membership role", async () => {
    roleResult = [{ role: "owner" }];

    const result = await privacyDataEraseHandler(
      { scope: "org", orgId: ORG_ID, confirm: true },
      makeCtx(),
    );

    expect(result.status).toBe("queued");
    expect(result.requestId).toBe(insertResult[0]?.id);
    expect(typeof result.effectiveAt).toBe("string");
    // org-scope erasure must emit the org-specific security event...
    expect(mockEmitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(firstArg<EmittedEvent>(mockEmitSecurityEvent)?.eventType).toBe(
      "privacy.org_erasure_requested",
    );
    // ...and dispatch the async hard-delete job.
    expect(mockEventSend).toHaveBeenCalledTimes(1);
    const orgJob = firstArg<InngestEvent>(mockEventSend);
    expect(orgJob?.name).toBe("privacy/erasure.execute");
    expect(orgJob?.data?.scope).toBe("org");
    // sessions are revoked (delete chain invoked)
    expect(tx.delete).toHaveBeenCalled();
  });

  it("throws Forbidden for org scope when the member is not an owner", async () => {
    roleResult = [{ role: "admin" }];
    await expect(
      privacyDataEraseHandler(
        { scope: "org", orgId: ORG_ID, confirm: true },
        makeCtx(),
      ),
    ).rejects.toThrow(/requires owner role/);
    expect(mockEventSend).not.toHaveBeenCalled();
  });

  it("throws Forbidden for org scope when the user has no membership row (IDOR guard)", async () => {
    roleResult = [];
    await expect(
      privacyDataEraseHandler(
        { scope: "org", orgId: ORG_ID, confirm: true },
        makeCtx(),
      ),
    ).rejects.toThrow(/Forbidden/);
    expect(mockEventSend).not.toHaveBeenCalled();
  });

  it("user scope succeeds without a role check and emits the user erasure event", async () => {
    // No roleResult needed — user scope must never query org membership.
    const result = await privacyDataEraseHandler(
      { scope: "user", confirm: true },
      makeCtx(),
    );

    expect(result.status).toBe("queued");
    expect(tx.select).not.toHaveBeenCalled(); // role check skipped for user scope
    expect(firstArg<EmittedEvent>(mockEmitSecurityEvent)?.eventType).toBe(
      "privacy.erasure_requested",
    );
    expect(mockEventSend).toHaveBeenCalledTimes(1);
    expect(firstArg<InngestEvent>(mockEventSend)?.data?.scope).toBe("user");
  });
});
