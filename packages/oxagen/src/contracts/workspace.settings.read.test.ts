import { describe, expect, it } from "vitest";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { getCapability } from "../registry";

describe("workspace.settings.read capability", () => {
  it("parses an empty input", () => {
    expect(workspaceSettingsRead.input.parse({})).toEqual({});
  });

  it("parses a valid output with a null description", () => {
    const out = workspaceSettingsRead.output.parse({ name: "W", slug: "w", description: null });
    expect(out.description).toBeNull();
  });

  it("rejects a missing slug", () => {
    expect(() => workspaceSettingsRead.output.parse({ name: "W", description: null })).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("workspace.settings.read")).toBe(workspaceSettingsRead);
  });
});
