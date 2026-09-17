/**
 * Contract test for import_tools (#2958).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolImport } from "./tool.import";

describe("import_tools is registered as declared", () => {
  it("is scoped, mutates=true and is never a governed action", () => {
    const cap = getCapability("import_tools");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
  });
});

describe("import_tools", () => {
  it("accepts a pull of every pinned tool, a pick, or declarations", () => {
    expect(toolImport.input.parse({ serverId: "mcs_1" })).toEqual({
      serverId: "mcs_1",
    });
    expect(
      toolImport.input.parse({ serverId: "mcs_1", tools: ["search"] }).tools,
    ).toEqual(["search"]);
    const declared = toolImport.input.parse({
      serverId: "mcs_1",
      declarations: [
        {
          name: "search",
          description: "Search",
          input_schema: { type: "object" },
          risk_grade: "low",
          manifest: { name: "search" },
        },
      ],
    });
    expect(declared.declarations?.[0]?.read_only).toBe(false);
  });

  it("refuses a pick and declarations together", () => {
    const result = toolImport.input.safeParse({
      serverId: "mcs_1",
      tools: ["search"],
      declarations: [
        {
          name: "search",
          description: "Search",
          input_schema: {},
          risk_grade: "low",
          manifest: {},
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("refuses an empty pick", () => {
    expect(
      toolImport.input.safeParse({ serverId: "mcs_1", tools: [] }).success,
    ).toBe(false);
  });
});
