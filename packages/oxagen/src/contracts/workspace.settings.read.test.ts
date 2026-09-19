import { describe, expect, it } from "vitest";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { getCapability } from "../registry";

/**
 * The two steering-freshness gates. Required on the output, not optional: a
 * handler always knows what the workspace applies, and an absent object would
 * be indistinguishable from "both off" at every reader.
 */
const STEERING = { autoSync: false, blockStaleRuns: false };

describe("workspace.settings.read capability", () => {
  it("parses an empty input", () => {
    expect(workspaceSettingsRead.input.parse({})).toEqual({});
  });

  it("parses a valid output with a null description", () => {
    // avatarUrl is nullable but required (avatarUrlOutputSchema) — handlers
    // always emit it, null when the workspace has no avatar.
    const out = workspaceSettingsRead.output.parse({
      name: "W",
      slug: "w",
      description: null,
      avatarUrl: null,
      consequenceRoles: {},
      steering: STEERING,
    });
    expect(out.description).toBeNull();
    expect(out.avatarUrl).toBeNull();
  });

  it("carries the effective consequence-role map and refuses a role outside the org roles", () => {
    const out = workspaceSettingsRead.output.parse({
      name: "W",
      slug: "w",
      description: null,
      avatarUrl: null,
      consequenceRoles: { moves_money: ["Owner", "Billing"] },
      steering: STEERING,
    });
    expect(out.consequenceRoles.moves_money).toEqual(["Owner", "Billing"]);
    expect(
      workspaceSettingsRead.output.safeParse({
        name: "W",
        slug: "w",
        description: null,
        avatarUrl: null,
        consequenceRoles: { moves_money: ["Viewer"] },
        steering: STEERING,
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsRead.output.safeParse({
        name: "W",
        slug: "w",
        description: null,
        avatarUrl: null,
        consequenceRoles: { moves_money: [] },
        steering: STEERING,
      }).success,
    ).toBe(false);
  });

  it("parses an output with an avatar URL", () => {
    const out = workspaceSettingsRead.output.parse({
      name: "W",
      slug: "w",
      description: null,
      avatarUrl: "https://cdn.example.com/w.png",
      consequenceRoles: {},
      steering: STEERING,
    });
    expect(out.avatarUrl).toBe("https://cdn.example.com/w.png");
  });

  it("rejects a missing slug", () => {
    expect(() =>
      workspaceSettingsRead.output.parse({
        name: "W",
        description: null,
        avatarUrl: null,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_workspace_settings")).toBe(workspaceSettingsRead);
  });
});
