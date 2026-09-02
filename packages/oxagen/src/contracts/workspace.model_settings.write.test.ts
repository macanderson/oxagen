import { describe, expect, it } from "vitest";
import { workspaceModelSettingsWrite } from "./workspace.model_settings.write";
import { getCapability } from "../registry";

describe("workspace.model.settings.write capability", () => {
  it("parses an empty input object (no-op update)", () => {
    const parsed = workspaceModelSettingsWrite.input.parse({});
    expect(parsed).toEqual({});
  });

  it("parses a partial input with only defaultTextTier", () => {
    const parsed = workspaceModelSettingsWrite.input.parse({
      defaultTextTier: "fast",
    });
    expect(parsed.defaultTextTier).toBe("fast");
    expect(parsed.defaultTextModel).toBeUndefined();
  });

  it("parses a full input with all four model fields", () => {
    const parsed = workspaceModelSettingsWrite.input.parse({
      defaultTextTier: "balanced",
      defaultTextModel: "anthropic/claude-sonnet-5",
      defaultImageModel: "openai/gpt-image-1",
      defaultVideoModel: "google/veo-3.0-generate-001",
    });
    expect(parsed.defaultTextTier).toBe("balanced");
    expect(parsed.defaultTextModel).toBe("anthropic/claude-sonnet-5");
  });

  it("parses null values for all fields (clear all overrides)", () => {
    const parsed = workspaceModelSettingsWrite.input.parse({
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    expect(parsed.defaultTextTier).toBeNull();
    expect(parsed.defaultTextModel).toBeNull();
    expect(parsed.defaultImageModel).toBeNull();
    expect(parsed.defaultVideoModel).toBeNull();
  });

  it("rejects an empty string for defaultTextModel (min(1))", () => {
    expect(() =>
      workspaceModelSettingsWrite.input.parse({ defaultTextModel: "" }),
    ).toThrow();
  });

  it("rejects an invalid defaultTextTier value", () => {
    expect(() =>
      workspaceModelSettingsWrite.input.parse({ defaultTextTier: "turbo" }),
    ).toThrow();
  });

  it("parses a valid output object", () => {
    const parsed = workspaceModelSettingsWrite.output.parse({
      defaultTextTier: "fast",
      defaultTextModel: null,
      defaultImageModel: "bfl/flux-2-max",
      defaultVideoModel: null,
    });
    expect(parsed.defaultTextTier).toBe("fast");
    expect(parsed.defaultImageModel).toBe("bfl/flux-2-max");
    expect(parsed.defaultVideoModel).toBeNull();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("update_model_settings")).toBe(
      workspaceModelSettingsWrite,
    );
  });

  it("declares scoped:true (workspace-scoped)", () => {
    expect(workspaceModelSettingsWrite.scoped).toBe(true);
  });
});
