import { describe, expect, it } from "vitest";
import { toolDefinitionSchema, toolsLoad } from "./tools.load";

describe("load_tools contract", () => {
  it("is a console read on the api, mcp and agent surfaces", () => {
    expect(toolsLoad.mutates).toBe(false);
    expect(toolsLoad.noBillingGate).toBe(true);
    expect(toolsLoad.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("takes one to eight names and refuses an empty list or a blank name", () => {
    expect(toolsLoad.input.parse({ names: ["list_runs"] })).toEqual({
      names: ["list_runs"],
    });
    expect(toolsLoad.input.safeParse({ names: [] }).success).toBe(false);
    expect(toolsLoad.input.safeParse({ names: [""] }).success).toBe(false);
    expect(
      toolsLoad.input.safeParse({ names: Array(9).fill("list_runs") }).success,
    ).toBe(false);
  });

  it("a definition carries the schema and the governance facts, and unknown names travel back", () => {
    const definition = {
      name: "list_runs",
      description: "List the runs",
      inputSchema: { type: "object", properties: {} },
      riskLevel: "low",
      requiresApproval: false,
      readOnly: true,
    };
    expect(toolDefinitionSchema.parse(definition)).toEqual(definition);
    expect(
      toolsLoad.output.parse({ tools: [definition], unknown: ["nope"] }),
    ).toEqual({ tools: [definition], unknown: ["nope"] });
    expect(
      toolDefinitionSchema.safeParse({ ...definition, riskLevel: "critical" })
        .success,
    ).toBe(false);
  });
});
