import { describe, expect, it } from "vitest";
import { tachoSessionPolicyWrite } from "./tacho.session_policy.write";
import { getCapability } from "../registry";

describe("update_tacho_session_policy capability", () => {
  it("is registered under its name", () => {
    expect(getCapability("update_tacho_session_policy")).toBe(
      tachoSessionPolicyWrite,
    );
  });

  it("is admin-only and consumes no credits", () => {
    expect(tachoSessionPolicyWrite.scoped).toBe(true);
    expect(tachoSessionPolicyWrite.noBillingGate).toBe(true);
    expect(tachoSessionPolicyWrite.defaultRoles.workspace.Owner).toBe("allow");
    expect(tachoSessionPolicyWrite.defaultRoles.workspace).not.toHaveProperty(
      "Member",
    );
  });

  it("parses an empty update, which changes nothing", () => {
    expect(tachoSessionPolicyWrite.input.parse({})).toEqual({});
  });

  it("distinguishes an omitted allowlist from a null one", () => {
    // Omitted keeps whatever is stored; null drops the allowlist. The
    // handler's merge reads `"modelAllow" in input`, so the schema has to
    // keep the key when it was sent as null.
    expect(tachoSessionPolicyWrite.input.parse({})).not.toHaveProperty(
      "modelAllow",
    );
    expect(
      tachoSessionPolicyWrite.input.parse({ modelAllow: null }),
    ).toHaveProperty("modelAllow", null);
  });

  it("refuses a ceiling of zero or less", () => {
    expect(() =>
      tachoSessionPolicyWrite.input.parse({ sessionLimitUsd: 0 }),
    ).toThrow();
    expect(() =>
      tachoSessionPolicyWrite.input.parse({ sessionLimitUsd: -1 }),
    ).toThrow();
  });

  it("requires the reach counts on the output", () => {
    // A saved allowlist can govern no machine, so the write always says how
    // many hosts will apply it. Making it required is what stops a surface
    // quietly rendering nothing.
    expect(() =>
      tachoSessionPolicyWrite.output.parse({
        mode: "enforced",
        sessionLimitUsd: 5,
        modelAllow: null,
        modelDeny: [],
      }),
    ).toThrow();
    const parsed = tachoSessionPolicyWrite.output.parse({
      mode: "enforced",
      sessionLimitUsd: 5,
      modelAllow: null,
      modelDeny: [],
      reach: { hosts: 3, hostsEnforcingModels: 1 },
    });
    expect(parsed.reach).toEqual({ hosts: 3, hostsEnforcingModels: 1 });
  });
});
