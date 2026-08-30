import { describe, expect, it } from "vitest";
import { sandboxTemplateDelete } from "./sandbox.template.delete";

describe("sandbox.template.delete contract", () => {
  it("registers with the correct name", () => {
    expect(sandboxTemplateDelete.name).toBe("delete_sandbox_template");
  });
  it("requires a templateId", () => {
    expect(() =>
      sandboxTemplateDelete.input.parse({ templateId: "sbx_1" }),
    ).not.toThrow();
    expect(() => sandboxTemplateDelete.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      sandboxTemplateDelete.output.parse({ ok: true }),
    ).not.toThrow();
  });
});
