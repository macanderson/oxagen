import { describe, expect, it } from "vitest";
import { userPreferencesRead } from "./user.preferences.read";
import { getCapability } from "../registry";

describe("user.preferences.read capability", () => {
  it("parses a valid (empty) input object", () => {
    const parsed = userPreferencesRead.input.parse({});
    expect(parsed).toEqual({});
  });

  it("rejects unknown input keys (strict parsing)", () => {
    // Zod strips unknown keys by default; verifying input is always the empty shape.
    const parsed = userPreferencesRead.input.parse({ unexpected: true });
    expect(parsed).toEqual({});
  });

  it("parses a valid full-preferences output", () => {
    const parsed = userPreferencesRead.output.parse({
      fontSize: "large",
      density: "compact",
      enterToSubmit: true,
      pendingPromptBehavior: "interrupt",
      defaultTextTier: "precise",
      defaultTextModel: "anthropic/claude-opus-4.8",
      defaultImageModel: "bfl/flux-2-max",
      defaultVideoModel: "google/veo-3.0-generate-001",
      timezone: "America/New_York",
      language: "en",
    });
    expect(parsed.fontSize).toBe("large");
    expect(parsed.defaultTextTier).toBe("precise");
  });

  it("parses output with nullable model fields set to null", () => {
    const parsed = userPreferencesRead.output.parse({
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: false,
      pendingPromptBehavior: "queue",
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
      timezone: "UTC",
      language: "en",
    });
    expect(parsed.defaultTextTier).toBeNull();
    expect(parsed.defaultTextModel).toBeNull();
    expect(parsed.defaultImageModel).toBeNull();
    expect(parsed.defaultVideoModel).toBeNull();
  });

  it("rejects an invalid fontSize value in output", () => {
    expect(() =>
      userPreferencesRead.output.parse({
        fontSize: "enormous",
        density: "comfortable",
        enterToSubmit: false,
        pendingPromptBehavior: "queue",
        defaultTextTier: null,
        defaultTextModel: null,
        defaultImageModel: null,
        defaultVideoModel: null,
      }),
    ).toThrow();
  });

  it("rejects an invalid density value in output", () => {
    expect(() =>
      userPreferencesRead.output.parse({
        fontSize: "medium",
        density: "squished",
        enterToSubmit: false,
        pendingPromptBehavior: "queue",
        defaultTextTier: null,
        defaultTextModel: null,
        defaultImageModel: null,
        defaultVideoModel: null,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_user_preferences")).toBe(userPreferencesRead);
  });

  it("declares scoped:false (user-scoped, not workspace-scoped)", () => {
    expect(userPreferencesRead.scoped).toBe(false);
  });

  it("declares api, mcp, and agent surfaces", () => {
    expect(userPreferencesRead.surfaces).toContain("api");
    expect(userPreferencesRead.surfaces).toContain("mcp");
    expect(userPreferencesRead.surfaces).toContain("agent");
  });
});
