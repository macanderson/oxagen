import { describe, expect, it } from "vitest";
import { agentToolList } from "./agent.tool.list";
import { getCapability } from "../registry";

describe("agent.tool.list capability", () => {
  it("parses a valid input", () => {
    const parsed = agentToolList.input.parse({ includeExternal: false });
    expect(parsed.includeExternal).toBe(false);
  });

  it("applies the default includeExternal flag", () => {
    const parsed = agentToolList.input.parse({});
    expect(parsed.includeExternal).toBe(true);
  });

  it("rejects a non-boolean includeExternal", () => {
    expect(() =>
      agentToolList.input.parse({ includeExternal: "yes" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentToolList.output.parse({
      tools: [
        {
          name: "recall_memory",
          description: "Recall memories",
          domain: "agent",
          category: "memory",
          riskLevel: "low",
          requiresApproval: false,
          external: false,
        },
      ],
    });
    expect(parsed.tools[0]?.name).toBe("recall_memory");
  });

  it("rejects an invalid riskLevel", () => {
    expect(() =>
      agentToolList.output.parse({
        tools: [
          {
            name: "x",
            description: "y",
            domain: "agent",
            category: null,
            riskLevel: "extreme",
            requiresApproval: false,
            external: false,
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_agent_tools")).toBe(agentToolList);
  });
});
