import { describe, expect, it } from "vitest";
import { workspaceSettingsWrite } from "./workspace.settings.write";
import { getCapability } from "../registry";

describe("workspace.settings.write capability", () => {
  it("parses a partial input (single field)", () => {
    const parsed = workspaceSettingsWrite.input.parse({ name: "Research Lab" });
    expect(parsed.name).toBe("Research Lab");
    expect(parsed.slug).toBeUndefined();
  });

  it("accepts null to clear the description", () => {
    const parsed = workspaceSettingsWrite.input.parse({ description: null });
    expect(parsed.description).toBeNull();
  });

  it("rejects an invalid (uppercase) slug", () => {
    expect(() =>
      workspaceSettingsWrite.input.parse({ slug: "Research_Lab" }),
    ).toThrow();
  });

  it("rejects an over-long description", () => {
    expect(() =>
      workspaceSettingsWrite.input.parse({ description: "x".repeat(2001) }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("update_workspace_settings")).toBe(
      workspaceSettingsWrite,
    );
  });
});
