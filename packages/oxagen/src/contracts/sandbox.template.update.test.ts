import { describe, expect, it } from "vitest";
import { sandboxTemplateUpdate } from "./sandbox.template.update";

describe("sandbox.template.update contract", () => {
  it("registers with the correct name", () => {
    expect(sandboxTemplateUpdate.name).toBe("update_sandbox_template");
  });
  it("accepts a partial update", () => {
    expect(() =>
      sandboxTemplateUpdate.input.parse({
        templateId: "sbx_1",
        isActive: false,
      }),
    ).not.toThrow();
    expect(() =>
      sandboxTemplateUpdate.input.parse({
        templateId: "sbx_1",
        provider: "docker",
        resources: { vcpu: 2 },
        network: { mode: "reverse_tunnel" },
        secretSelection: { keyPublicIds: ["sk_1", "sk_2"] },
      }),
    ).not.toThrow();
  });
  it("accepts packages as an optional update field", () => {
    const parsed = sandboxTemplateUpdate.input.parse({
      templateId: "sbx_1",
      packages: [{ manager: "npm", names: ["react", "typescript"] }],
    });
    expect(parsed.packages).toEqual([
      { manager: "npm", names: ["react", "typescript"] },
    ]);
    // A group with names omitted defaults to [].
    const withDefault = sandboxTemplateUpdate.input.parse({
      templateId: "sbx_1",
      packages: [{ manager: "apt" }],
    });
    expect(withDefault.packages).toEqual([{ manager: "apt", names: [] }]);
  });
  it("rejects an unknown package manager in the update input", () => {
    expect(() =>
      sandboxTemplateUpdate.input.parse({
        templateId: "sbx_1",
        packages: [{ manager: "conda", names: [] }],
      }),
    ).toThrow();
  });
  it("rejects out-of-bound resources", () => {
    expect(() =>
      sandboxTemplateUpdate.input.parse({
        templateId: "sbx_1",
        resources: { memoryMb: 999999 },
      }),
    ).toThrow();
  });
  it("requires templateId", () => {
    expect(() => sandboxTemplateUpdate.input.parse({ name: "x" })).toThrow();
  });
});
