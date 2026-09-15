import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { PERMISSION_IDS } from "../iam/permission-catalog";
import { iamRoleCreate, roleNameSchema } from "./iam.role.create";

describe("create_role contract", () => {
  it("is a settings write for org Owners and Admins: noBillingGate, mutates, deny by default", () => {
    expect(getCapability("create_role")).toBe(iamRoleCreate);
    expect(iamRoleCreate.noBillingGate).toBe(true);
    expect(iamRoleCreate.mutates).toBe(true);
    expect(iamRoleCreate.scoped).toBe(true);
    expect(iamRoleCreate.defaultEffect).toBe("deny");
    expect(iamRoleCreate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(iamRoleCreate.layers).not.toContain("e2e");
  });

  it("parses a role over catalogue permissions and defaults the description to null", () => {
    const parsed = iamRoleCreate.input.parse({
      name: "agent.release",
      scopeKind: "workspace",
      permissions: ["repo.read", "run.read"],
    });
    expect(parsed.description).toBeNull();
    expect(parsed.permissions).toEqual(["repo.read", "run.read"]);
  });

  it("refuses a permission outside the catalogue (negative)", () => {
    const result = iamRoleCreate.input.safeParse({
      name: "agent.release",
      scopeKind: "workspace",
      permissions: ["org.*"],
    });
    expect(result.success).toBe(false);
    expect(PERMISSION_IDS).not.toContain("org.*");
  });

  it("refuses an empty permission set (negative)", () => {
    expect(
      iamRoleCreate.input.safeParse({
        name: "agent.release",
        scopeKind: "workspace",
        permissions: [],
      }).success,
    ).toBe(false);
  });

  it("refuses a name outside the lower-case dotted shape and a scope kind the table lacks (negative)", () => {
    for (const name of [
      "Agent.Release",
      "agent release",
      ".agent",
      "a",
      "agent..x",
    ]) {
      expect(roleNameSchema.safeParse(name).success, name).toBe(false);
    }
    expect(roleNameSchema.safeParse("svc.ci-runner_2").success).toBe(true);
    expect(
      iamRoleCreate.input.safeParse({
        name: "agent.release",
        scopeKind: "repository",
        permissions: ["repo.read"],
      }).success,
    ).toBe(false);
  });
});
