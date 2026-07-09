import { describe, expect, it } from "vitest";
import { sandboxTemplateList } from "./sandbox.template.list";

const template = {
  id: "sbx_1",
  environmentId: "env_1",
  name: "T",
  slug: "t",
  description: null,
  isDefault: true,
  isActive: true,
  provider: "modal" as const,
  runtime: null,
  resources: {},
  network: { mode: "public" as const },
  secretSelection: "all" as const,
  literalEnv: {},
  tools: [],
};

describe("sandbox.template.list contract", () => {
  it("registers with the correct name", () => {
    expect(sandboxTemplateList.name).toBe("list_sandbox_templates");
  });
  it("accepts an empty input and an environmentId filter", () => {
    expect(() => sandboxTemplateList.input.parse({})).not.toThrow();
    expect(() => sandboxTemplateList.input.parse({ environmentId: "env_1" })).not.toThrow();
  });
  it("accepts a valid output array", () => {
    expect(() => sandboxTemplateList.output.parse({ templates: [template] })).not.toThrow();
  });
});
