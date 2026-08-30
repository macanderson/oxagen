import { describe, expect, it, vi, beforeEach } from "vitest";

// ── @oxagen/database mock ────────────────────────────────────────────────────
// consent.resolve does an UPDATE ... RETURNING on approval_requests.
const state = vi.hoisted(() => ({
  updateReturning: [
    { id: "apr_1", capabilityName: "mcp.srv_1.list_prs" },
  ] as unknown[],
}));
const returningMock = vi.fn(async () => state.updateReturning);
const whereMock = vi.fn(() => ({ returning: returningMock }));
const setMock = vi.fn(() => ({ where: whereMock }));
const updateMock = vi.fn(() => ({ set: setMock }));
const fakeDb = { update: updateMock };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
    schema: {
      approvalRequests: {
        id: "a.id",
        orgId: "a.orgId",
        resolution: "a.resolution",
        resolvedAt: "a.resolvedAt",
        resolvedByUserId: "a.resolvedByUserId",
        note: "a.note",
        expiresAt: "a.expiresAt",
        capabilityName: "a.capabilityName",
      },
    },
  };
});

const runtimeMocks = vi.hoisted(() => ({
  notifyResolution: vi.fn(async () => undefined),
  recordConsent: vi.fn(async () => ({ consentId: "mcons_1" })),
  listConsents: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../runtime/approval", () => ({
  notifyResolution: runtimeMocks.notifyResolution,
}));
vi.mock("../runtime/consent", () => ({
  recordConsent: runtimeMocks.recordConsent,
  listConsents: runtimeMocks.listConsents,
  DEFAULT_CONSENT_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  CONSENT_WILDCARD: "*",
}));

import { agentMcpConsentResolveHandler } from "./agent.mcp_consent.resolve";
import { agentMcpConsentListHandler } from "./agent.mcp_consent.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.mcp.consent.resolve handler", () => {
  beforeEach(() => {
    state.updateReturning = [
      { id: "apr_1", capabilityName: "mcp.srv_1.list_prs" },
    ];
    updateMock.mockClear();
    returningMock.mockClear();
    runtimeMocks.notifyResolution.mockClear();
    runtimeMocks.recordConsent.mockClear();
  });

  it("resolves the approval, records a per-tool grant, and notifies", async () => {
    const out = await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted" },
      CTX,
    );
    expect(out).toEqual({ approvalId: "apr_1", resolution: "granted" });
    // Per-tool grant (not wildcard) with a finite TTL.
    expect(runtimeMocks.recordConsent).toHaveBeenCalledTimes(1);
    const arg = (
      runtimeMocks.recordConsent.mock.calls[0] as unknown as [
        {
          toolName: string;
          status: string;
          ttlMs: number | null;
        },
      ]
    )[0];
    expect(arg.toolName).toBe("list_prs");
    expect(arg.status).toBe("granted");
    expect(arg.ttlMs).toBeGreaterThan(0);
    // The runtime is unblocked with the approval vocabulary (approved).
    expect(runtimeMocks.notifyResolution).toHaveBeenCalledWith({
      approvalId: "apr_1",
      resolution: "approved",
      note: null,
    });
  });

  it("writes a non-expiring wildcard pre-grant when grantAllTools is set", async () => {
    await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted", grantAllTools: true },
      CTX,
    );
    const arg = (
      runtimeMocks.recordConsent.mock.calls[0] as unknown as [
        {
          toolName: string;
          ttlMs: number | null;
        },
      ]
    )[0];
    expect(arg.toolName).toBe("*");
    expect(arg.ttlMs).toBeNull();
  });

  it("records a denial and notifies the runtime with denied", async () => {
    const out = await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "denied" },
      CTX,
    );
    expect(out.resolution).toBe("denied");
    expect(
      (
        runtimeMocks.recordConsent.mock.calls[0] as unknown as [
          { status: string },
        ]
      )[0].status,
    ).toBe("denied");
    expect(runtimeMocks.notifyResolution).toHaveBeenCalledWith({
      approvalId: "apr_1",
      resolution: "denied",
      note: null,
    });
  });

  it("returns expired (and skips consent write) when the row is gone / already resolved", async () => {
    state.updateReturning = [];
    const out = await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted" },
      CTX,
    );
    expect(out).toEqual({ approvalId: "apr_1", resolution: "expired" });
    expect(runtimeMocks.recordConsent).not.toHaveBeenCalled();
    expect(runtimeMocks.notifyResolution).not.toHaveBeenCalled();
  });
});

describe("agent.mcp.consent.list handler", () => {
  beforeEach(() => {
    runtimeMocks.listConsents.mockClear();
    runtimeMocks.listConsents.mockResolvedValue([]);
  });

  it("lists all workspace grants by default", async () => {
    runtimeMocks.listConsents.mockResolvedValueOnce([
      {
        publicId: "mcons_1",
        userId: "u_1",
        mcpServerId: "srv_1",
        toolName: "list_prs",
        status: "granted",
        grantedAt: "2026-06-19T00:00:00.000Z",
        deniedAt: null,
        expiresAt: null,
      },
    ]);
    const out = await agentMcpConsentListHandler({}, CTX);
    expect(out.consents).toHaveLength(1);
    expect(runtimeMocks.listConsents).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      userId: null,
    });
  });

  it("scopes to the calling user when mineOnly is set", async () => {
    await agentMcpConsentListHandler({ mineOnly: true }, CTX);
    expect(runtimeMocks.listConsents).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      userId: CTX.userId,
    });
  });
});
