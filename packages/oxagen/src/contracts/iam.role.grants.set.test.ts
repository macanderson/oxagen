import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { iamRoleGrantsSet } from "./iam.role.grants.set";

describe("set_role_grants contract", () => {
  it("is a settings write for org Owners and Admins: noBillingGate, mutates, deny by default", () => {
    expect(getCapability("set_role_grants")).toBe(iamRoleGrantsSet);
    expect(iamRoleGrantsSet.noBillingGate).toBe(true);
    expect(iamRoleGrantsSet.mutates).toBe(true);
    expect(iamRoleGrantsSet.defaultEffect).toBe("deny");
    expect(iamRoleGrantsSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes a public role id and a non-empty catalogue permission set", () => {
    expect(
      iamRoleGrantsSet.input.parse({
        roleId: "rol_abc",
        permissions: ["run.read"],
      }),
    ).toEqual({ roleId: "rol_abc", permissions: ["run.read"] });
  });

  it("refuses an internal uuid, an empty set and an unknown permission (negative)", () => {
    expect(
      iamRoleGrantsSet.input.safeParse({
        roleId: "3f6c2b1e-0000-4000-8000-000000000000",
        permissions: ["run.read"],
      }).success,
    ).toBe(false);
    expect(
      iamRoleGrantsSet.input.safeParse({ roleId: "rol_abc", permissions: [] })
        .success,
    ).toBe(false);
    expect(
      iamRoleGrantsSet.input.safeParse({
        roleId: "rol_abc",
        permissions: ["repo.merge"],
      }).success,
    ).toBe(false);
  });
});
