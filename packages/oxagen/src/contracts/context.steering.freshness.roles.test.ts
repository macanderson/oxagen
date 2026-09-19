import { describe, expect, it } from "vitest";
import { contextSteeringFreshness } from "./context.steering.freshness";

// A denial of this read is not a failed panel: the CLI swallows platform
// errors so a prompt is never blocked by the platform, which means a denied
// caller's machine silently lost the workspace's gates and their agent ran
// ungated. Everyone who can see the workspace has to be able to ask.
describe("get_steering_freshness grants", () => {
  const roles = contextSteeringFreshness.defaultRoles;

  // The set `workspace_users_role_check` enforces. Leaving any out denied
  // that member, and the CLI then ran their agent without the workspace gates.
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

  // The grants above do not decide the enterprise path. There the resolver
  // reads `iam.principal_role_assignments`, workspace membership is written
  // to `workspace_users`, and no human path creates the assignment that joins
  // them, so a deny default refused every plain workspace member and the CLI
  // turned that 403 into a machine with no gates.
  it("defaults to allow, so a workspace member with no IAM assignment is answered", () => {
    expect(contextSteeringFreshness.defaultEffect).toBe("allow");
  });
});
