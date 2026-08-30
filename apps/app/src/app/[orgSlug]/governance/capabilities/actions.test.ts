/**
 * actions.test.ts — unit tests for the capability-catalog drawer action.
 *
 * Covers fetchCapabilityInsights:
 *  - input validation (bad capability name) → error, no invokes
 *  - unauthenticated → error, no invokes
 *  - membership assert failure → error (deny is explicit, nothing fails open)
 *  - happy path → detail + usage slice keyed to the capability + audit events
 *  - usage/audit failures degrade to null independently; detail failure errors
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSession, mockResolveOrg, mockAssertOrgMember, mockInvoke } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockInvoke: vi.fn(),
  }));

vi.mock("@/lib/session", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("../_lib/invoke-org", () => ({
  invokeOrgCapability: mockInvoke,
  ORG_ONLY_WS: "00000000-0000-0000-0000-000000000000",
}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { fetchCapabilityInsights } from "./actions";

const DETAIL = {
  capability: {
    name: "query_audit_log",
    domain: "audit",
    description: "d",
    mode: "sync",
    surfaces: ["api"],
    layers: ["api"],
    sensitivity: "high",
    defaultEffect: "deny",
    scoped: true,
    noBillingGate: false,
    agent: null,
    auditTargetKind: null,
    plugin: null,
    orgRoles: {},
    workspaceRoles: {},
    inputFields: [],
    outputFields: [],
    auditTargetIdField: null,
    produces: [],
    consumes: [],
    chainHints: [],
  },
};

const USAGE = {
  byCapability: [
    {
      key: "query_audit_log",
      provider: "",
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      costMicros: 1234,
      executions: 3,
    },
  ],
};

const AUDIT = {
  events: [
    {
      source: "security",
      eventType: "capability.invoked",
      occurredAt: "2026-07-01T00:00:00.000Z",
      actorUserId: "u1",
      workspaceId: null,
      capability: "query_audit_log",
      outcome: "allow",
      requestId: null,
      playbookRunId: null,
      sequence: null,
      eventData: null,
    },
  ],
  total: 1,
  hasMore: false,
  limit: 10,
  offset: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockInvoke.mockImplementation(
    async (_org: string, _user: string, name: string) => {
      if (name === "get_capability_registry") return DETAIL;
      if (name === "get_usage_breakdown") return USAGE;
      if (name === "query_audit_log") return AUDIT;
      throw new Error(`unexpected capability ${name}`);
    },
  );
});

describe("fetchCapabilityInsights", () => {
  it("rejects a malformed capability name without invoking", async () => {
    const out = await fetchCapabilityInsights("acme", "DROP TABLE;");
    expect(out.error).toBe("Invalid request.");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers", async () => {
    mockGetSession.mockResolvedValue(null);
    const out = await fetchCapabilityInsights("acme", "query_audit_log");
    expect(out.error).toBe("Not authenticated.");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("denies non-members explicitly (nothing fails open)", async () => {
    mockAssertOrgMember.mockRejectedValue(new Error("nope"));
    const out = await fetchCapabilityInsights("acme", "query_audit_log");
    expect(out.error).toBe("Not authorized.");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns detail + the capability's usage slice + audit events", async () => {
    const out = await fetchCapabilityInsights("acme", "query_audit_log");
    expect(out.error).toBeUndefined();
    expect(out.detail?.name).toBe("query_audit_log");
    expect(out.usage).toEqual({
      costMicros: 1234,
      executions: 3,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(out.audit).toHaveLength(1);
  });

  it("returns a zero usage slice when the capability has no metered rows", async () => {
    mockInvoke.mockImplementation(
      async (_o: string, _u: string, name: string) => {
        if (name === "get_capability_registry") return DETAIL;
        if (name === "get_usage_breakdown") return { byCapability: [] };
        if (name === "query_audit_log") return AUDIT;
        throw new Error("unexpected");
      },
    );
    const out = await fetchCapabilityInsights("acme", "query_audit_log");
    expect(out.usage).toEqual({
      costMicros: 0,
      executions: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("degrades usage and audit to null independently", async () => {
    mockInvoke.mockImplementation(
      async (_o: string, _u: string, name: string) => {
        if (name === "get_capability_registry") return DETAIL;
        throw new Error("analytics down");
      },
    );
    const out = await fetchCapabilityInsights("acme", "query_audit_log");
    expect(out.detail?.name).toBe("query_audit_log");
    expect(out.usage).toBeNull();
    expect(out.audit).toBeNull();
    expect(out.error).toBeUndefined();
  });

  it("errors when the detail read itself fails", async () => {
    mockInvoke.mockImplementation(
      async (_o: string, _u: string, name: string) => {
        if (name === "get_capability_registry")
          throw new Error("registry down");
        if (name === "get_usage_breakdown") return USAGE;
        return AUDIT;
      },
    );
    const out = await fetchCapabilityInsights("acme", "query_audit_log");
    expect(out.detail).toBeNull();
    expect(out.error).toBe("Unable to load the contract detail.");
  });
});
