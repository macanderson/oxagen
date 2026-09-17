import { describe, expect, it } from "vitest";
import { agentMcpList } from "./agent.mcp.list";
import { getCapability } from "../registry";

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

  it("parses a plugin-installed server row (transport sse, health unknown)", () => {
    // packages/handlers/src/plugin.set_enabled.ts writes newly enabled
    // servers with exactly these values; the DB CHECK admits both.
    const parsed = agentMcpList.output.parse({
      servers: [
        {
          publicId: "mcp_b",
          name: "github",
          transportType: "sse",
          endpointUrl: "https://mcp.github.com/sse",
          healthStatus: "unknown",
          lastHealthcheckAt: null,
          toolCount: 0,
        },
      ],
    });
    expect(parsed.servers[0]?.transportType).toBe("sse");
    expect(parsed.servers[0]?.healthStatus).toBe("unknown");
  });

  it("parses every transportType the DB CHECK admits", () => {
    for (const transportType of ["streamable-http", "sse", "stdio"]) {
      const parsed = agentMcpList.output.parse({
        servers: [
          {
            publicId: "mcp_c",
            name: "x",
            transportType,
            endpointUrl: "https://mcp.example.com",
            healthStatus: "healthy",
            lastHealthcheckAt: null,
            toolCount: 0,
          },
        ],
      });
      expect(parsed.servers[0]?.transportType).toBe(transportType);
    }
  });

  it("parses every healthStatus the DB CHECK admits", () => {
    for (const healthStatus of [
      "healthy",
      "degraded",
      "unreachable",
      "unknown",
    ]) {
      const parsed = agentMcpList.output.parse({
        servers: [
          {
            publicId: "mcp_d",
            name: "x",
            transportType: "stdio",
            endpointUrl: "stdio://x",
            healthStatus,
            lastHealthcheckAt: null,
            toolCount: 0,
          },
        ],
      });
      expect(parsed.servers[0]?.healthStatus).toBe(healthStatus);
    }
  });

  it("rejects a transportType outside the DB CHECK", () => {
    expect(() =>
      agentMcpList.output.parse({
        servers: [
          {
            publicId: "mcp_e",
            name: "x",
            transportType: "websocket",
            endpointUrl: "wss://mcp.example.com",
            healthStatus: "healthy",
            lastHealthcheckAt: null,
            toolCount: 0,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a healthStatus outside the DB CHECK", () => {
    expect(() =>
      agentMcpList.output.parse({
        servers: [
          {
            publicId: "mcp_f",
            name: "x",
            transportType: "stdio",
            endpointUrl: "stdio://x",
            healthStatus: "pending",
            lastHealthcheckAt: null,
            toolCount: 0,
          },
        ],
      }),
    ).toThrow();
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
    expect(getCapability("list_mcp_servers")).toBe(agentMcpList);
  });
});
