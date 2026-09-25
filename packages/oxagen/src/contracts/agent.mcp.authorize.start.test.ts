import { describe, expect, it } from "vitest";
import { agentMcpAuthorizeStart } from "./agent.mcp.authorize.start";

const REDIRECT = "https://app.oxagen.sh/api/v1/mcp/oauth/callback";

describe("start_mcp_authorization contract", () => {
  it("is admitted to org Owners and Admins and workspace Owners only", () => {
    expect(agentMcpAuthorizeStart.name).toBe("start_mcp_authorization");
    expect(agentMcpAuthorizeStart.defaultEffect).toBe("deny");
    expect(agentMcpAuthorizeStart.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
  });

  it("takes an add, a reconnect, and a workspace OAuth app", () => {
    expect(
      agentMcpAuthorizeStart.input.parse({
        name: "Slack",
        endpointUrl: "https://mcp.slack.com/mcp",
        client: { clientId: " 123 ", scopes: "chat:write" },
        redirectUrl: REDIRECT,
      }).client?.clientId,
    ).toBe("123");
    expect(
      agentMcpAuthorizeStart.input.parse({
        mcpServerId: "mcs_1",
        redirectUrl: REDIRECT,
      }).mcpServerId,
    ).toBe("mcs_1");
    expect(() =>
      agentMcpAuthorizeStart.input.parse({
        client: { clientId: "" },
        redirectUrl: REDIRECT,
      }),
    ).toThrow();
    expect(() =>
      agentMcpAuthorizeStart.input.parse({ mcpServerId: "mcs_1" }),
    ).toThrow();
  });

  it("parses each outcome by its status", () => {
    const parse = (v: unknown) => agentMcpAuthorizeStart.output.parse(v);
    expect(
      parse({
        status: "redirect",
        authorizationUrl: "https://x/authorize",
        state: "s",
      }).status,
    ).toBe("redirect");
    expect(
      parse({ status: "client_required", scopesSupported: ["read"] }).status,
    ).toBe("client_required");
    expect(parse({ status: "not_oauth" }).status).toBe("not_oauth");
    expect(
      parse({
        status: "authorized",
        mcpServerId: "mcs_1",
        healthStatus: "healthy",
        discoveredTools: [],
      }).status,
    ).toBe("authorized");
    expect(() => parse({ status: "redirect" })).toThrow();
  });
});
