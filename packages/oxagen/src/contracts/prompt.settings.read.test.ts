import { describe, it, expect } from "vitest";
import { promptSettingsRead } from "./prompt.settings.read";

describe("prompt.settings.read contract", () => {
  it("declares api + mcp + agent surfaces and a workspace domain", () => {
    expect(promptSettingsRead.name).toBe("get_prompt_settings");
    expect(promptSettingsRead.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
    expect(promptSettingsRead.domain).toBe("workspace");
  });

  it("accepts an empty input", () => {
    expect(promptSettingsRead.input.parse({})).toEqual({});
  });

  it("validates the output shape (instructions, overrides, autoImprove)", () => {
    const valid = {
      additionalInstructions: "Be terse.",
      overrides: { "svg.generate": "flat" },
      autoImprovePrompts: true,
    };
    expect(promptSettingsRead.output.parse(valid)).toEqual(valid);
    // null instructions + empty overrides is valid.
    expect(
      promptSettingsRead.output.parse({
        additionalInstructions: null,
        overrides: {},
        autoImprovePrompts: false,
      }),
    ).toBeTruthy();
  });

  it("rejects output missing autoImprovePrompts", () => {
    expect(() =>
      promptSettingsRead.output.parse({
        additionalInstructions: null,
        overrides: {},
      }),
    ).toThrow();
  });
});
