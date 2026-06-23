/**
 * first-party-mcp.test.ts — validates the GitHub MCP static descriptor.
 *
 * These are data-correctness tests: they ensure the descriptor constants are
 * well-formed, have the right endpoint/auth/transport values, and that the
 * FIRST_PARTY_MCP_SERVERS array contains exactly the servers we expect.
 */

import { describe, it, expect } from "vitest";
import {
  GITHUB_MCP_SERVER,
  FIRST_PARTY_MCP_SERVERS,
  type FirstPartyMcpServer,
} from "./first-party-mcp";

describe("GITHUB_MCP_SERVER", () => {
  it("has the canonical hosted GitHub MCP endpoint URL", () => {
    expect(GITHUB_MCP_SERVER.endpointUrl).toBe(
      "https://api.githubcopilot.com/mcp/",
    );
  });

  it("uses oauth authKind (MCP OAuth 2.1 flow)", () => {
    expect(GITHUB_MCP_SERVER.authKind).toBe("oauth");
  });

  it("uses streamable-http transport (hosted remote server)", () => {
    expect(GITHUB_MCP_SERVER.transport).toBe("streamable-http");
  });

  it('has pluginType "mcp_server"', () => {
    expect(GITHUB_MCP_SERVER.pluginType).toBe("mcp_server");
  });

  it('has canonical name "github-mcp"', () => {
    expect(GITHUB_MCP_SERVER.name).toBe("github-mcp");
  });

  it("has a non-empty title and description", () => {
    expect(GITHUB_MCP_SERVER.title.length).toBeGreaterThan(0);
    expect(GITHUB_MCP_SERVER.description.length).toBeGreaterThan(0);
  });

  it("satisfies the FirstPartyMcpServer interface shape", () => {
    const server: FirstPartyMcpServer = GITHUB_MCP_SERVER;
    // If this compiles and runs, the shape is correct.
    expect(server).toBeDefined();
  });
});

describe("FIRST_PARTY_MCP_SERVERS", () => {
  it("includes GITHUB_MCP_SERVER", () => {
    const names = FIRST_PARTY_MCP_SERVERS.map((s) => s.name);
    expect(names).toContain("github-mcp");
  });

  it("has at least one entry", () => {
    expect(FIRST_PARTY_MCP_SERVERS.length).toBeGreaterThan(0);
  });

  it("all entries have unique names", () => {
    const names = FIRST_PARTY_MCP_SERVERS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("all entries have non-empty endpointUrl, name, title, description", () => {
    for (const server of FIRST_PARTY_MCP_SERVERS) {
      expect(server.endpointUrl.length).toBeGreaterThan(0);
      expect(server.name.length).toBeGreaterThan(0);
      expect(server.title.length).toBeGreaterThan(0);
      expect(server.description.length).toBeGreaterThan(0);
    }
  });

  it("all entries use streamable-http transport", () => {
    for (const server of FIRST_PARTY_MCP_SERVERS) {
      expect(server.transport).toBe("streamable-http");
    }
  });
});
