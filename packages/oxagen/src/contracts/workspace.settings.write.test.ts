import { describe, expect, it } from "vitest";
import { workspaceSettingsWrite } from "./workspace.settings.write";
import { getCapability } from "../registry";

describe("workspace.settings.write capability", () => {
  it("is a settings write, never a governed action (INV-28)", () => {
    expect(workspaceSettingsWrite.noBillingGate).toBe(true);
    expect(workspaceSettingsWrite.mutates).toBe(true);
  });

  it("names another workspace of the org by public id only (negative: a uuid or a slug is refused)", () => {
    expect(
      workspaceSettingsWrite.input.parse({ workspaceId: "wrk_abc", name: "X" })
        .workspaceId,
    ).toBe("wrk_abc");
    expect(
      workspaceSettingsWrite.input.safeParse({
        workspaceId: "3f6c2b1e-0000-4000-8000-000000000000",
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsWrite.input.safeParse({ workspaceId: "core" }).success,
    ).toBe(false);
  });

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
