import { describe, expect, it } from "vitest";
import { workspaceModelSettingsRead } from "./workspace.model_settings.read";
import { getCapability } from "../registry";

describe("workspace.model.settings.read capability", () => {
  it("parses a valid empty input object", () => {
    const parsed = workspaceModelSettingsRead.input.parse({});
    expect(parsed).toEqual({});
  });

  it("parses a valid output with all four fields set", () => {
    const parsed = workspaceModelSettingsRead.output.parse({
      defaultTextTier: "balanced",
      defaultTextModel: "anthropic/claude-sonnet-5",
      defaultImageModel: "bfl/flux-2-max",
      defaultVideoModel: "google/veo-3.0-generate-001",
    });
    expect(parsed.defaultTextTier).toBe("balanced");
    expect(parsed.defaultTextModel).toBe("anthropic/claude-sonnet-5");
    expect(parsed.defaultImageModel).toBe("bfl/flux-2-max");
    expect(parsed.defaultVideoModel).toBe("google/veo-3.0-generate-001");
  });

  it("parses a valid output with all fields null", () => {
    const parsed = workspaceModelSettingsRead.output.parse({
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

  it("rejects an invalid defaultTextTier value", () => {
    expect(() =>
      workspaceModelSettingsRead.output.parse({
        defaultTextTier: "turbo",
        defaultTextModel: null,
        defaultImageModel: null,
        defaultVideoModel: null,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_model_settings")).toBe(
      workspaceModelSettingsRead,
    );
  });

  it("declares scoped:true (workspace-scoped)", () => {
    expect(workspaceModelSettingsRead.scoped).toBe(true);
  });

  it("declares api, mcp, and agent surfaces", () => {
    expect(workspaceModelSettingsRead.surfaces).toContain("api");
    expect(workspaceModelSettingsRead.surfaces).toContain("mcp");
    expect(workspaceModelSettingsRead.surfaces).toContain("agent");
  });
});
