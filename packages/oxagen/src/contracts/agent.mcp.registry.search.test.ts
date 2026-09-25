import { describe, expect, it } from "vitest";
import { agentMcpRegistrySearch } from "./agent.mcp.registry.search";

const server = {
  id: "verified/linear",
  name: "Linear",
  description: "Issues",
  publisher: "linear.app",
  publisherVerified: true,
  source: "verified",
  version: null,
  iconUrl: "https://linear.app/favicon.ico",
  websiteUrl: "https://linear.app",
  docsUrl: "https://linear.app/docs/mcp",
  repositoryUrl: null,
  endpointUrl: "https://mcp.linear.app/mcp",
  transports: ["streamable-http"],
  auth: "oauth",
  authHeader: null,
  oauthRegistration: "dynamic",
  connectable: true,
};

describe("search_mcp_registry contract", () => {
  it("is a read-only, billing-free search on api and mcp", () => {
    expect(agentMcpRegistrySearch.name).toBe("search_mcp_registry");
    expect(agentMcpRegistrySearch.surfaces).toEqual(["api", "mcp"]);
    expect(agentMcpRegistrySearch.mutates).toBe(false);
    expect(agentMcpRegistrySearch.noBillingGate).toBe(true);
  });

  it("defaults the query and limit, and bounds the limit", () => {
    expect(agentMcpRegistrySearch.input.parse({})).toEqual({
      query: "",
      limit: 20,
    });
    expect(() => agentMcpRegistrySearch.input.parse({ limit: 31 })).toThrow();
    expect(() =>
      agentMcpRegistrySearch.input.parse({ query: "x".repeat(121) }),
    ).toThrow();
  });

  it("parses a result page and refuses an unknown auth kind", () => {
    const page = {
      servers: [server],
      nextCursor: null,
      registryReachable: true,
    };
    expect(agentMcpRegistrySearch.output.parse(page).servers[0]?.auth).toBe(
      "oauth",
    );
    expect(() =>
      agentMcpRegistrySearch.output.parse({
        ...page,
        servers: [{ ...server, auth: "magic" }],
      }),
    ).toThrow();
  });
});
