import { describe, expect, it } from "vitest";
import { userPreferencesRead } from "./user.preferences.read";
import type { SystemOrgRole, SystemWorkspaceRole } from "../types";
import { getCapability } from "../registry";

/**
 * The role enumerations as values: adding a role to either union fails to
 * compile here until someone has decided what it means for a person's own
 * settings. The org map named `Member` and `Viewer`, which are workspace
 * roles, and omitted `Compliance` and `Billing`, which are the org roles it
 * needed, so an enterprise org seeded grants for Owner and Admin alone.
 */
const EVERY_ORG_ROLE: Record<SystemOrgRole, true> = {
  Owner: true,
  Admin: true,
  Compliance: true,
  Billing: true,
};
const EVERY_WORKSPACE_ROLE: Record<SystemWorkspaceRole, true> = {
  Owner: true,
  Member: true,
  Viewer: true,
};

describe("user.preferences.read capability", () => {
  it("is self-scoped: intrinsically allowed, and every real role at each scope", () => {
    expect(userPreferencesRead.defaultEffect).toBe("allow");
    expect(Object.keys(userPreferencesRead.defaultRoles.org).sort()).toEqual(
      Object.keys(EVERY_ORG_ROLE).sort(),
    );
    expect(
      Object.keys(userPreferencesRead.defaultRoles.workspace).sort(),
    ).toEqual(Object.keys(EVERY_WORKSPACE_ROLE).sort());
  });

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
      timezone: "America/New_York",
      language: "en",
      theme: "system",
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
      timezone: "UTC",
      language: "en",
      theme: "system",
    });
    expect(parsed.defaultTextTier).toBeNull();
    expect(parsed.defaultTextModel).toBeNull();
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
