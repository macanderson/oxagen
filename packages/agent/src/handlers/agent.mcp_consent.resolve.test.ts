import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTenantDbMock,
  recordConsentMock,
  notifyResolutionMock,
  updateReturning,
  updateSets,
} = vi.hoisted(() => ({
  withTenantDbMock: vi.fn(),
  recordConsentMock: vi.fn(),
  notifyResolutionMock: vi.fn(),
  updateReturning: { rows: [] as Record<string, unknown>[] },
  updateSets: { calls: [] as Record<string, unknown>[] },
}));

// A fake tx that records the `.set()` clause and serves `.returning()` from the
// hoisted fixture, so the resolve handler's atomic-update contract is testable
// without a live database.
function makeTx() {
  return {
    update: () => ({
      set: (s: Record<string, unknown>) => {
        updateSets.calls.push(s);
        return {
          where: () => ({ returning: async () => updateReturning.rows }),
        };
      },
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  withTenantDbMock.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(makeTx()),
  );
  return { ...real, withTenantDb: withTenantDbMock };
});
vi.mock("../runtime/approval", () => ({
  notifyResolution: notifyResolutionMock,
}));
vi.mock("../runtime/consent", async (importOriginal) => {
  const real = await importOriginal<typeof import("../runtime/consent")>();
  return { ...real, recordConsent: recordConsentMock };
});

import { agentMcpConsentResolveHandler } from "./agent.mcp_consent.resolve";
import { CONSENT_WILDCARD, DEFAULT_CONSENT_TTL_MS } from "../runtime/consent";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

const SERVER_ID = "1f3b6c22-9d1e-4a55-9d3d-6d1f0c9a2b77";

beforeEach(() => {
  recordConsentMock.mockReset();
  notifyResolutionMock.mockReset();
  updateSets.calls = [];
  updateReturning.rows = [];
});

describe("agent.mcp_consent.resolve handler", () => {
  it("reports `expired` when the row was already resolved or timed out", async () => {
    updateReturning.rows = [];

    const out = await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted" },
      TEST_CTX,
    );

    expect(out).toEqual({ approvalId: "apr_1", resolution: "expired" });
    expect(recordConsentMock).not.toHaveBeenCalled();
    expect(notifyResolutionMock).not.toHaveBeenCalled();
  });

  it("maps a grant onto the approval vocabulary and records a per-tool consent", async () => {
    updateReturning.rows = [
      { id: "apr_1", capabilityName: `mcp.${SERVER_ID}.search.web` },
    ];

    const out = await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted" },
      TEST_CTX,
    );

    expect(updateSets.calls[0]).toMatchObject({
      resolution: "approved",
      resolvedByUserId: "u_1",
      note: null,
    });
    expect(recordConsentMock).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "u_1",
      serverId: SERVER_ID,
      // The tool name keeps its dots — only the first one after `mcp.` splits.
      toolName: "search.web",
      status: "granted",
      ttlMs: DEFAULT_CONSENT_TTL_MS,
    });
    expect(notifyResolutionMock).toHaveBeenCalledWith({
      approvalId: "apr_1",
      resolution: "approved",
      note: null,
    });
    expect(out).toEqual({ approvalId: "apr_1", resolution: "granted" });
  });

  it("stores a never-expiring wildcard grant when grantAllTools is set", async () => {
    updateReturning.rows = [
      { id: "apr_1", capabilityName: `mcp.${SERVER_ID}.search` },
    ];

    await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted", grantAllTools: true },
      TEST_CTX,
    );

    expect(recordConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: CONSENT_WILDCARD, ttlMs: null }),
    );
  });

  it("never widens a denial to a wildcard — grantAllTools is ignored", async () => {
    updateReturning.rows = [
      { id: "apr_1", capabilityName: `mcp.${SERVER_ID}.search` },
    ];

    const out = await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "denied", grantAllTools: true },
      TEST_CTX,
    );

    expect(updateSets.calls[0]).toMatchObject({ resolution: "denied" });
    expect(recordConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "search",
        status: "denied",
        ttlMs: DEFAULT_CONSENT_TTL_MS,
      }),
    );
    expect(out).toEqual({ approvalId: "apr_1", resolution: "denied" });
  });

  it("skips the durable consent when the capability is not an MCP synthetic", async () => {
    updateReturning.rows = [
      { id: "apr_1", capabilityName: "list_workspace_agents" },
    ];

    await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted" },
      TEST_CTX,
    );

    expect(recordConsentMock).not.toHaveBeenCalled();
    // The paused runtime is still unblocked.
    expect(notifyResolutionMock).toHaveBeenCalledTimes(1);
  });

  it("skips the durable consent for a malformed synthetic name", async () => {
    updateReturning.rows = [{ id: "apr_1", capabilityName: "mcp..tool" }];

    await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted" },
      TEST_CTX,
    );

    expect(recordConsentMock).not.toHaveBeenCalled();
  });

  it("skips the durable consent when there is no user to attribute it to", async () => {
    updateReturning.rows = [
      { id: "apr_1", capabilityName: `mcp.${SERVER_ID}.search` },
    ];

    await agentMcpConsentResolveHandler(
      { approvalId: "apr_1", decision: "granted" },
      makeCTX({ userId: null }),
    );

    expect(recordConsentMock).not.toHaveBeenCalled();
    expect(notifyResolutionMock).toHaveBeenCalledTimes(1);
  });
});
