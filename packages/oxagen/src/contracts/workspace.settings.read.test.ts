import { describe, expect, it } from "vitest";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { getCapability } from "../registry";

describe("workspace.settings.read capability", () => {
  it("parses an empty input", () => {
    expect(workspaceSettingsRead.input.parse({})).toEqual({});
  });

  it("parses a valid output with a null description", () => {
    const out = workspaceSettingsRead.output.parse({
      name: "W",
      slug: "w",
      description: null,
      avatarUrl: null,
    });
    expect(out.description).toBeNull();
    expect(out.avatarUrl).toBeNull();
  });

  it("parses an output with an avatar URL", () => {
    const out = workspaceSettingsRead.output.parse({
      name: "W",
      slug: "w",
      description: null,
      avatarUrl: "https://cdn.example.com/w.png",
    });
    expect(out.avatarUrl).toBe("https://cdn.example.com/w.png");
  });

  it("rejects a missing slug", () => {
    expect(() =>
      workspaceSettingsRead.output.parse({ name: "W", description: null, avatarUrl: null }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_workspace_settings")).toBe(workspaceSettingsRead);
  });
});
