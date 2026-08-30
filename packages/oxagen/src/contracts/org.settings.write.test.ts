import { describe, expect, it } from "vitest";
import { orgSettingsWrite } from "./org.settings.write";
import { getCapability } from "../registry";

describe("org.settings.write capability", () => {
  it("parses a partial input (single field)", () => {
    const parsed = orgSettingsWrite.input.parse({ name: "Acme Inc" });
    expect(parsed.name).toBe("Acme Inc");
    expect(parsed.slug).toBeUndefined();
  });

  it("accepts null to clear nullable profile fields", () => {
    const parsed = orgSettingsWrite.input.parse({
      avatarUrl: null,
      website: null,
      industry: null,
    });
    expect(parsed.avatarUrl).toBeNull();
    expect(parsed.website).toBeNull();
  });

  it("rejects an invalid (uppercase) slug", () => {
    expect(() => orgSettingsWrite.input.parse({ slug: "Acme_Co" })).toThrow();
  });

  it("rejects an out-of-range employeeSize", () => {
    expect(() => orgSettingsWrite.input.parse({ employeeSize: "3" })).toThrow();
  });

  it("rejects a non-URL avatarUrl", () => {
    expect(() =>
      orgSettingsWrite.input.parse({ avatarUrl: "not-a-url" }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("update_org_settings")).toBe(orgSettingsWrite);
  });
});
