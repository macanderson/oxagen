import { describe, expect, it } from "vitest";
import { orgSettingsRead } from "./org.settings.read";
import { getCapability } from "../registry";

describe("org.settings.read capability", () => {
  it("parses an empty input", () => {
    expect(orgSettingsRead.input.parse({})).toEqual({});
  });

  it("parses a valid output", () => {
    const out = orgSettingsRead.output.parse({
      name: "Acme",
      slug: "acme",
      avatarUrl: null,
      website: null,
      industry: null,
      employeeSize: "11-50",
      type: "business",
    });
    expect(out.employeeSize).toBe("11-50");
  });

  it("rejects an out-of-range employeeSize", () => {
    expect(() =>
      orgSettingsRead.output.parse({
        name: "Acme",
        slug: "acme",
        avatarUrl: null,
        website: null,
        industry: null,
        employeeSize: "3",
        type: "business",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_org_settings")).toBe(orgSettingsRead);
  });
});
