import { describe, expect, it } from "vitest";
import { agentMcpDelete } from "./agent.mcp.delete";
import { getCapability } from "../registry";

describe("agent.mcp.delete capability", () => {
  it("parses a valid input", () => {
    expect(
      agentMcpDelete.input.parse({ mcpServerId: "mcs_1" }).mcpServerId,
    ).toBe("mcs_1");
  });

  it("rejects a missing server id", () => {
    expect(() => agentMcpDelete.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    expect(
      agentMcpDelete.output.parse({ mcpServerId: "mcs_1", deleted: true })
        .deleted,
    ).toBe(true);
  });

  it("is registered with high sensitivity", () => {
    expect(getCapability("delete_mcp_server")).toBe(agentMcpDelete);
    expect(agentMcpDelete.sensitivity).toBe("high");
  });
});
