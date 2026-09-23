import { describe, expect, it } from "vitest";
import { orgSsoGroupRolesSet } from "./org.sso.group_roles.set";
import { getCapability } from "../registry";

describe("org.sso.group_roles.set capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("set_sso_group_roles")).toBe(orgSsoGroupRolesSet);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgSsoGroupRolesSet.scoped).toBe(false);
    expect(orgSsoGroupRolesSet.sensitivity).toBe("high");
    expect(orgSsoGroupRolesSet.defaultEffect).toBe("deny");
    expect(orgSsoGroupRolesSet.noBillingGate).toBe(true);
    expect(orgSsoGroupRolesSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSsoGroupRolesSet.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool: the in-app agent never reconfigures sign-in", () => {
    expect("agent" in orgSsoGroupRolesSet).toBe(false);
  });

  it("refuses a group mapped twice", () => {
    const res = orgSsoGroupRolesSet.input.safeParse({
      providerId: "acme",
      mappings: [
        { group: "eng", role: "member" },
        { group: "eng", role: "admin" },
      ],
    });
    expect(res.success).toBe(false);
  });

  it("refuses owner, which an identity provider never grants", () => {
    const res = orgSsoGroupRolesSet.input.safeParse({
      providerId: "acme",
      mappings: [{ group: "founders", role: "owner" }],
    });
    expect(res.success).toBe(false);
  });

  it("refuses more than 200 rows", () => {
    const res = orgSsoGroupRolesSet.input.safeParse({
      providerId: "acme",
      mappings: Array.from({ length: 201 }, (_, i) => ({
        group: `g${i}`,
        role: "member",
      })),
    });
    expect(res.success).toBe(false);
  });

  it("treats group names as case-sensitive", () => {
    const res = orgSsoGroupRolesSet.input.safeParse({
      providerId: "acme",
      mappings: [
        { group: "Admins", role: "admin" },
        { group: "admins", role: "member" },
      ],
    });
    expect(res.success).toBe(true);
  });
});
