import { describe, expect, it } from "vitest";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { getCapability } from "../registry";

describe("workspace.settings.read capability", () => {
  it("parses an empty input", () => {
    expect(workspaceSettingsRead.input.parse({})).toEqual({});
  });

  it("parses a valid output with a null description", () => {
    // avatarUrl is a required (nullable) field of the output schema.
    const out = workspaceSettingsRead.output.parse({
      name: "W",
      slug: "w",
      description: null,
      avatarUrl: null,
    });
    expect(out.description).toBeNull();
    expect(out.avatarUrl).toBeNull();
  });

  it("rejects a missing slug", () => {
    expect(() =>
      workspaceSettingsRead.output.parse({ name: "W", description: null }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_workspace_settings")).toBe(workspaceSettingsRead);
  });
});
