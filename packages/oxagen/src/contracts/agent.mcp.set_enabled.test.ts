import { describe, expect, it } from "vitest";
import { agentMcpSetEnabled } from "./agent.mcp.set_enabled";
import { getCapability } from "../registry";

describe("agent.mcp.set_enabled capability", () => {
  it("parses a valid enable and disable input", () => {
    expect(
      agentMcpSetEnabled.input.parse({ mcpServerId: "mcs_1", enabled: true })
        .enabled,
    ).toBe(true);
    expect(
      agentMcpSetEnabled.input.parse({ mcpServerId: "mcs_1", enabled: false })
        .enabled,
    ).toBe(false);
  });

  it("rejects a non-boolean enabled flag", () => {
    expect(() =>
      agentMcpSetEnabled.input.parse({ mcpServerId: "mcs_1", enabled: "yes" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentMcpSetEnabled.output.parse({
      mcpServerId: "mcs_1",
      enabled: true,
      snapshotCount: 3,
    });
    expect(parsed.snapshotCount).toBe(3);
  });

  it("rejects a negative snapshot count", () => {
    expect(() =>
      agentMcpSetEnabled.output.parse({
        mcpServerId: "mcs_1",
        enabled: true,
        snapshotCount: -1,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("set_mcp_enabled")).toBe(agentMcpSetEnabled);
  });
});
