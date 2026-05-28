import { describe, expect, it } from "vitest";
import { agentMcpList } from "./agent.mcp.list.js";
import { getCapability } from "../registry.js";

describe("agent.mcp.list capability", () => {
  it("parses an empty input", () => {
    const parsed = agentMcpList.input.parse({});
    expect(parsed).toEqual({});
  });

  it("parses a valid output", () => {
    const parsed = agentMcpList.output.parse({
      servers: [
        {
          publicId: "mcp_a",
          name: "linear",
          transportType: "streamable-http",
          endpointUrl: "https://mcp.linear.app/sse",
          healthStatus: "healthy",
          lastHealthcheckAt: new Date().toISOString(),
          toolCount: 5,
        },
      ],
    });
    expect(parsed.servers[0]?.toolCount).toBe(5);
  });

  it("accepts a null lastHealthcheckAt", () => {
    const parsed = agentMcpList.output.parse({
      servers: [
        {
          publicId: "mcp_a",
          name: "linear",
          transportType: "stdio",
          endpointUrl: "stdio://linear",
          healthStatus: "unreachable",
          lastHealthcheckAt: null,
          toolCount: 0,
        },
      ],
    });
    expect(parsed.servers[0]?.lastHealthcheckAt).toBeNull();
  });

  it("rejects a negative toolCount", () => {
    expect(() =>
      agentMcpList.output.parse({
        servers: [
          {
            publicId: "mcp_a",
            name: "x",
            transportType: "stdio",
            endpointUrl: "stdio://x",
            healthStatus: "healthy",
            lastHealthcheckAt: null,
            toolCount: -1,
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.mcp.list")).toBe(agentMcpList);
  });
});
