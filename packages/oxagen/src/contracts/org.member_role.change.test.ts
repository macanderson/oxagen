import { describe, expect, it } from "vitest";
import { orgMemberRoleChange } from "./org.member_role.change";
import { getCapability } from "../registry";

describe("org.member.role.change capability", () => {
  it("parses a valid input", () => {
    const parsed = orgMemberRoleChange.input.parse({
      targetUserId: "usr_abc",
      newRole: "Admin",
    });
    expect(parsed).toEqual({ targetUserId: "usr_abc", newRole: "Admin" });
  });

  it("rejects an empty targetUserId", () => {
    expect(() =>
      orgMemberRoleChange.input.parse({ targetUserId: "", newRole: "Admin" }),
    ).toThrow();
  });

  it("rejects an empty newRole", () => {
    expect(() =>
      orgMemberRoleChange.input.parse({ targetUserId: "usr_abc", newRole: "" }),
    ).toThrow();
  });

  it("parses a valid output with a nullable previousRole", () => {
    const parsed = orgMemberRoleChange.output.parse({
      changed: true,
      targetUserId: "usr_abc",
      orgId: "org_1",
      previousRole: null,
      newRole: "Admin",
    });
    expect(parsed.changed).toBe(true);
    expect(parsed.previousRole).toBeNull();
  });

  it("accepts a non-null previousRole", () => {
    const parsed = orgMemberRoleChange.output.parse({
      changed: true,
      targetUserId: "usr_abc",
      orgId: "org_1",
      previousRole: "Member",
      newRole: "Admin",
    });
    expect(parsed.previousRole).toBe("Member");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("change_member_role")).toBe(orgMemberRoleChange);
  });

  it("is high-risk and default-deny", () => {
    expect(orgMemberRoleChange.sensitivity).toBe("high");
    expect(orgMemberRoleChange.defaultEffect).toBe("deny");
    expect(orgMemberRoleChange.agent?.riskLevel).toBe("high");
  });
});
