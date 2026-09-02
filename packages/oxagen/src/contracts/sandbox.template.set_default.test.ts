import { describe, expect, it } from "vitest";
import { sandboxTemplateSetDefault } from "./sandbox.template.set_default";

describe("sandbox.template.set_default contract", () => {
  it("registers with the correct name and a conforming action", () => {
    expect(sandboxTemplateSetDefault.name).toBe("set_default_sandbox_template");
  });
  it("requires a templateId", () => {
    expect(() =>
      sandboxTemplateSetDefault.input.parse({ templateId: "sbx_1" }),
    ).not.toThrow();
    expect(() => sandboxTemplateSetDefault.input.parse({})).toThrow();
  });
  it("is Owner/Admin gated", () => {
    expect(sandboxTemplateSetDefault.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });
});
