import { describe, expect, it } from "vitest";
import { contextSteeringLayout } from "./context.steering.layout";

// A denial here is not a failed panel: it would make the creation wizard's
// preview step guess a path and branch instead of reading them, which is the
// defect #4765 fixes. Everyone who can open the wizard has to be able to ask.
describe("get_steering_layout grants", () => {
  const roles = contextSteeringLayout.defaultRoles;

  it("admits every role a workspace member can hold", () => {
    expect(Object.keys(roles.workspace).sort()).toEqual(
      ["Admin", "Billing", "Compliance", "Member", "Owner", "Viewer"].sort(),
    );
    expect(Object.values(roles.workspace).every((e) => e === "allow")).toBe(
      true,
    );
  });

  it("admits every org role", () => {
    expect(roles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    });
  });

  // An org `Member` does not exist; naming it read as coverage and granted
  // nothing.
  it("names no org role outside SystemOrgRole", () => {
    expect(Object.keys(roles.org)).not.toContain("Member");
  });

  it("defaults to allow, so a workspace member with no IAM assignment is answered", () => {
    expect(contextSteeringLayout.defaultEffect).toBe("allow");
  });
});
