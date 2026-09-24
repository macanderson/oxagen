import { describe, expect, it } from "vitest";
import { orgScimTokenRotate } from "./org.scim_token.rotate";
import { getCapability } from "../registry";

describe("org.scim_token.rotate capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("rotate_scim_token")).toBe(orgScimTokenRotate);
  });

  it("is governed: org Owner or Admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgScimTokenRotate.scoped).toBe(false);
    expect(orgScimTokenRotate.sensitivity).toBe("high");
    expect(orgScimTokenRotate.defaultEffect).toBe("deny");
    expect(orgScimTokenRotate.noBillingGate).toBe(true);
    expect(orgScimTokenRotate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgScimTokenRotate.surfaces).toEqual(["api"]);
  });

  it("is not an agent tool", () => {
    expect("agent" in orgScimTokenRotate).toBe(false);
  });

  it("takes no input", () => {
    expect(orgScimTokenRotate.input.parse({})).toEqual({});
  });
});
