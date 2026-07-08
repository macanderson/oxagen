import { describe, expect, it } from "vitest";
import { agentMcpRegister } from "./agent.mcp.register";
import { getCapability } from "../registry";

describe("agent.mcp.register capability", () => {
  it("parses a valid input with defaults", () => {
    const parsed = agentMcpRegister.input.parse({
      name: "linear",
      transportType: "streamable-http",
      endpointUrl: "https://mcp.linear.app/sse",
    });
    expect(parsed.authStrategy).toBe("none");
  });

  it("rejects an invalid endpoint URL", () => {
    expect(() =>
      agentMcpRegister.input.parse({
        name: "x",
        transportType: "stdio",
        endpointUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects an unknown transport", () => {
    expect(() =>
      agentMcpRegister.input.parse({
        name: "x",
        transportType: "websocket",
        endpointUrl: "https://example.com",
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentMcpRegister.output.parse({
      mcpServerId: "mcp_abc",
      healthStatus: "healthy",
      discoveredTools: ["list_issues", "get_issue"],
    });
    expect(parsed.discoveredTools).toHaveLength(2);
  });

  it("rejects an unknown health status", () => {
    expect(() =>
      agentMcpRegister.output.parse({
        mcpServerId: "x",
        healthStatus: "fine",
        discoveredTools: [],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("register_mcp_server")).toBe(agentMcpRegister);
  });
});
