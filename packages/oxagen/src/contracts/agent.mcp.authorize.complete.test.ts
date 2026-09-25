import { describe, expect, it } from "vitest";
import { agentMcpAuthorizeComplete } from "./agent.mcp.authorize.complete";

describe("authorize_mcp_server contract", () => {
  it("is admitted to org Owners and Admins and workspace Owners only", () => {
    expect(agentMcpAuthorizeComplete.name).toBe(
      "authorize_mcp_server",
    );
    expect(agentMcpAuthorizeComplete.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
  });

  it("requires the state, the code and the redirect URL", () => {
    const input = {
      state: "s",
      code: "c",
      redirectUrl: "https://app.oxagen.sh/api/v1/mcp/oauth/callback",
    };
    expect(agentMcpAuthorizeComplete.input.parse(input)).toEqual(input);
    expect(() =>
      agentMcpAuthorizeComplete.input.parse({ ...input, code: "" }),
    ).toThrow();
    expect(() =>
      agentMcpAuthorizeComplete.input.parse({ ...input, redirectUrl: "nope" }),
    ).toThrow();
  });

  it("returns the provider and never a token", () => {
    const out = agentMcpAuthorizeComplete.output.parse({
      mcpServerId: "mcs_1",
      name: "Linear",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
      accessToken: "leak",
    });
    expect(out).not.toHaveProperty("accessToken");
  });
});
