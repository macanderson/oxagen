import { describe, expect, it } from "vitest";
import { contextSteeringFreshness } from "./context.steering.freshness";

// A denial of this read is not a failed panel: the CLI swallows platform
// errors so a prompt is never blocked by the platform, which means a denied
// caller's machine silently lost the workspace's gates and their agent ran
// ungated. Everyone who can see the workspace has to be able to ask.
describe("get_steering_freshness grants", () => {
  const roles = contextSteeringFreshness.defaultRoles;

  it("admits every workspace role, Viewer included", () => {
    expect(roles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("admits every org role", () => {
    expect(roles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    });
  });

  // The previous grant named roles that do not exist, which read as coverage
  // and granted nothing.
  it("names no role outside the system role sets", () => {
    expect(Object.keys(roles.org)).not.toContain("Member");
    expect(Object.keys(roles.workspace)).not.toContain("Admin");
  });
});
