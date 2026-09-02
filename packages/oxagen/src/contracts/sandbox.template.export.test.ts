import { describe, expect, it } from "vitest";
import { sandboxTemplateExport } from "./sandbox.template.export";

describe("sandbox.template.export contract", () => {
  it("registers with the correct name", () => {
    expect(sandboxTemplateExport.name).toBe("export_sandbox_template");
  });
  it("requires a templateId", () => {
    expect(() =>
      sandboxTemplateExport.input.parse({ templateId: "sbx_1" }),
    ).not.toThrow();
    expect(() => sandboxTemplateExport.input.parse({})).toThrow();
  });
  it("outputs a v1 manifest with secret NAMES only (no value field)", () => {
    const out = sandboxTemplateExport.output.parse({
      manifest: {
        kind: "oxagen.sandbox-template",
        version: 1,
        name: "SWE-bench",
        slug: "swe-bench",
        provider: "modal",
        resources: { vcpu: 2 },
        network: { mode: "public" },
        secretSelection: "all",
        literalEnv: {},
        tools: [{ kind: "capability", ref: "agent.code.execute" }],
        secretKeys: [
          { key: "AI_GATEWAY_API_KEY", sensitive: true, required: true },
        ],
      },
    });
    expect(out.manifest.secretKeys[0]).not.toHaveProperty("value");
    expect(out.manifest.secretKeys[0]!.key).toBe("AI_GATEWAY_API_KEY");
  });
});
