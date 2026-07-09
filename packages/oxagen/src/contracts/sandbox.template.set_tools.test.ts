import { describe, expect, it } from "vitest";
import { sandboxTemplateSetTools } from "./sandbox.template.set_tools";

describe("sandbox.template.set_tools contract", () => {
  it("registers with the ADR-022-conforming name (folded compound action)", () => {
    expect(sandboxTemplateSetTools.name).toBe("set_sandbox_template_tools");
  });
  it("accepts a replace-set of tools (including empty)", () => {
    expect(() =>
      sandboxTemplateSetTools.input.parse({ templateId: "sbx_1", tools: [] }),
    ).not.toThrow();
    expect(() =>
      sandboxTemplateSetTools.input.parse({
        templateId: "sbx_1",
        tools: [
          { kind: "capability", ref: "agent.code.execute" },
          { kind: "mcp_server", ref: "mcp_1", config: { url: "https://x" } },
        ],
      }),
    ).not.toThrow();
  });
  it("rejects an unknown tool kind", () => {
    expect(() =>
      sandboxTemplateSetTools.input.parse({
        templateId: "sbx_1",
        tools: [{ kind: "bogus", ref: "x" }],
      }),
    ).toThrow();
  });
});
