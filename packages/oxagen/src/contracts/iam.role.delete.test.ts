import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { iamRoleDelete } from "./iam.role.delete";

describe("delete_role contract", () => {
  it("is a settings write for org Owners and Admins: noBillingGate, mutates, deny by default", () => {
    expect(getCapability("delete_role")).toBe(iamRoleDelete);
    expect(iamRoleDelete.noBillingGate).toBe(true);
    expect(iamRoleDelete.mutates).toBe(true);
    expect(iamRoleDelete.defaultEffect).toBe("deny");
    expect(iamRoleDelete.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes a public role id and refuses anything else (negative)", () => {
    expect(iamRoleDelete.input.parse({ roleId: "rol_abc" })).toEqual({
      roleId: "rol_abc",
    });
    expect(iamRoleDelete.input.safeParse({ roleId: "Owner" }).success).toBe(
      false,
    );
    expect(iamRoleDelete.input.safeParse({}).success).toBe(false);
  });

  it("answers with the deleted role's id and name", () => {
    expect(
      iamRoleDelete.output.parse({ id: "rol_abc", name: "agent.release" }),
    ).toEqual({ id: "rol_abc", name: "agent.release" });
  });
});
