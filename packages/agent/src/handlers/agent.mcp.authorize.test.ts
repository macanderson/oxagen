import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: m.assertOrgRole,
  resolveActingUserId: m.resolveActingUserId,
}));
vi.mock("../runtime/mcp-oauth-flow", () => ({
  startMcpAuthorization: m.start,
  completeMcpAuthorization: m.complete,
}));
vi.mock("../runtime/mcp-registry", () => ({ searchMcpRegistry: m.search }));

import { agentMcpAuthorizeStartHandler } from "./agent.mcp.authorize.start";
import { agentMcpAuthorizeCompleteHandler } from "./agent.mcp.authorize.complete";
import { agentMcpRegistrySearchHandler } from "./agent.mcp.registry.search";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const REDIRECT = "https://app.oxagen.sh/api/v1/mcp/oauth/callback";

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveActingUserId.mockResolvedValue("user-9");
  m.assertOrgRole.mockResolvedValue("Owner");
});

describe("start_mcp_authorization handler", () => {
  it("asserts the role for the acting user, then starts the flow in the caller's workspace", async () => {
    m.start.mockResolvedValue({ status: "not_oauth" });
    const input = {
      name: "X",
      endpointUrl: "https://x.dev/mcp",
      redirectUrl: REDIRECT,
    };
    await expect(agentMcpAuthorizeStartHandler(input, CTX)).resolves.toEqual({
      status: "not_oauth",
    });
    expect(m.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-9" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    expect(m.start).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: "user-9" },
      input,
    );
  });

  it("starts nothing when the role check refuses", async () => {
    m.assertOrgRole.mockRejectedValue(
      Object.assign(new Error("no"), {
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    await expect(
      agentMcpAuthorizeStartHandler(
        { mcpServerId: "mcs_1", redirectUrl: REDIRECT },
        CTX,
      ),
    ).rejects.toMatchObject({ reason: "org_role_required" });
    expect(m.start).not.toHaveBeenCalled();
  });
});

describe("authorize_mcp_server handler", () => {
  it("asserts the role and completes in the caller's workspace", async () => {
    m.complete.mockResolvedValue({
      mcpServerId: "mcs_1",
      name: "Linear",
      healthStatus: "healthy",
      discoveredTools: [],
    });
    const input = { state: "s", code: "c", redirectUrl: REDIRECT };
    await agentMcpAuthorizeCompleteHandler(input, CTX);
    expect(m.assertOrgRole).toHaveBeenCalled();
    expect(m.complete).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: "user-9" },
      input,
    );
  });

  it("completes nothing when the role check refuses", async () => {
    m.assertOrgRole.mockRejectedValue(new Error("no"));
    await expect(
      agentMcpAuthorizeCompleteHandler(
        { state: "s", code: "c", redirectUrl: REDIRECT },
        CTX,
      ),
    ).rejects.toThrow("no");
    expect(m.complete).not.toHaveBeenCalled();
  });
});

describe("search_mcp_registry handler", () => {
  it("passes the query, cursor and limit through", async () => {
    m.search.mockResolvedValue({
      servers: [],
      nextCursor: null,
      registryReachable: true,
    });
    await agentMcpRegistrySearchHandler(
      { query: "linear", cursor: "c", limit: 5 },
      CTX,
    );
    expect(m.search).toHaveBeenCalledWith({
      query: "linear",
      cursor: "c",
      limit: 5,
    });
    await agentMcpRegistrySearchHandler({ query: "", limit: 20 }, CTX);
    expect(m.search).toHaveBeenLastCalledWith({ query: "", limit: 20 });
  });
});
