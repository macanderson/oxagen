import { describe, expect, it } from "vitest";
import { sandboxTemplateGet } from "./sandbox.template.get";

describe("sandbox.template.get contract", () => {
  it("registers with the correct name", () => {
    expect(sandboxTemplateGet.name).toBe("get_sandbox_template");
  });
  it("requires a templateId", () => {
    expect(() =>
      sandboxTemplateGet.input.parse({ templateId: "sbx_1" }),
    ).not.toThrow();
    expect(() => sandboxTemplateGet.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      sandboxTemplateGet.output.parse({
        template: {
          id: "sbx_1",
          environmentId: "env_1",
          name: "T",
          slug: "t",
          description: null,
          isDefault: false,
          isActive: true,
          provider: "vercel",
          runtime: null,
          resources: {},
          network: { mode: "public" },
          secretSelection: "all",
          literalEnv: {},
          packages: [],
          tools: [],
        },
      }),
    ).not.toThrow();
  });
});
