import { describe, it, expect } from "vitest";
import { promptSettingsWrite } from "./prompt.settings.write";

describe("prompt.settings.write contract", () => {
  it("is medium-sensitivity, deny-by-default, owner/admin only", () => {
    expect(promptSettingsWrite.sensitivity).toBe("medium");
    expect(promptSettingsWrite.defaultEffect).toBe("deny");
    expect(promptSettingsWrite.defaultRoles?.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("accepts a partial update (any subset of fields)", () => {
    expect(
      promptSettingsWrite.input.parse({ additionalInstructions: "x" }),
    ).toBeTruthy();
    expect(
      promptSettingsWrite.input.parse({ autoImprovePrompts: false }),
    ).toBeTruthy();
    expect(
      promptSettingsWrite.input.parse({
        overrides: { "image.analyze": "describe briefly" },
      }),
    ).toBeTruthy();
    expect(promptSettingsWrite.input.parse({})).toEqual({});
  });

  it("allows clearing via null", () => {
    expect(
      promptSettingsWrite.input.parse({ additionalInstructions: null })
        .additionalInstructions,
    ).toBeNull();
    expect(
      promptSettingsWrite.input.parse({ overrides: null }).overrides,
    ).toBeNull();
  });

  it("rejects an override longer than the cap", () => {
    expect(() =>
      promptSettingsWrite.input.parse({
        overrides: { "svg.generate": "x".repeat(5000) },
      }),
    ).toThrow();
  });

  it("rejects an unknown override key", () => {
    expect(() =>
      // chat.system is append-only and not a valid override key.
      promptSettingsWrite.input.parse({ overrides: { "chat.system": "evil" } }),
    ).not.toThrow(); // unknown keys are stripped by the partial object, not an error
    const parsed = promptSettingsWrite.input.parse({
      overrides: { "chat.system": "evil", "svg.generate": "ok" },
    });
    expect(
      (parsed.overrides as Record<string, unknown>)["chat.system"],
    ).toBeUndefined();
  });
});
