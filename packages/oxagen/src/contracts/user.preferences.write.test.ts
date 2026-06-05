import { describe, expect, it } from "vitest";
import { userPreferencesWrite } from "./user.preferences.write";
import { getCapability } from "../registry";

describe("user.preferences.write capability", () => {
  it("parses an empty input object (no-op update)", () => {
    const parsed = userPreferencesWrite.input.parse({});
    expect(parsed).toEqual({});
  });

  it("parses a partial input with only fontSize", () => {
    const parsed = userPreferencesWrite.input.parse({ fontSize: "small" });
    expect(parsed.fontSize).toBe("small");
    expect(parsed.density).toBeUndefined();
  });

  it("parses a full input with all fields", () => {
    const parsed = userPreferencesWrite.input.parse({
      fontSize: "large",
      density: "compact",
      enterToSubmit: true,
      pendingPromptBehavior: "interrupt",
      defaultTextTier: "precise",
      defaultTextModel: "anthropic/claude-opus-4.8",
      defaultImageModel: "bfl/flux-2",
      defaultVideoModel: "google/veo-3",
    });
    expect(parsed.fontSize).toBe("large");
    expect(parsed.pendingPromptBehavior).toBe("interrupt");
    expect(parsed.defaultTextTier).toBe("precise");
  });

  it("parses null values for nullable model fields (clear)", () => {
    const parsed = userPreferencesWrite.input.parse({
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(parsed.defaultTextTier).toBeNull();
    expect(parsed.defaultTextModel).toBeNull();
  });

  it("rejects an empty string for defaultTextModel (min(1))", () => {
    expect(() =>
      userPreferencesWrite.input.parse({ defaultTextModel: "" }),
    ).toThrow();
  });

  it("rejects an invalid pendingPromptBehavior value", () => {
    expect(() =>
      userPreferencesWrite.input.parse({ pendingPromptBehavior: "defer" }),
    ).toThrow();
  });

  it("parses a valid full-preferences output", () => {
    const parsed = userPreferencesWrite.output.parse({
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: false,
      pendingPromptBehavior: "queue",
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(parsed.fontSize).toBe("medium");
    expect(parsed.defaultTextTier).toBeNull();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("user.preferences.write")).toBe(userPreferencesWrite);
  });

  it("declares scoped:false (user-scoped)", () => {
    expect(userPreferencesWrite.scoped).toBe(false);
  });
});
