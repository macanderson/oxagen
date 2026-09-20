// The rule both run-command surfaces gate on, held to `dispatch_command`'s
// own `defaultRoles`: org Owner or Admin, or workspace Owner or Member.
import { describe, expect, it } from "vitest";
import { canCommandRun } from "./run-command-roles";

describe("canCommandRun", () => {
  it("admits an organization Owner or Admin whatever the workspace role is", () => {
    expect(canCommandRun("owner", "viewer")).toBe(true);
    expect(canCommandRun("admin", "viewer")).toBe(true);
  });

  it("admits a workspace Owner or Member whose organization role is only Viewer", () => {
    expect(canCommandRun("viewer", "owner")).toBe(true);
    expect(canCommandRun("viewer", "member")).toBe(true);
  });

  it("refuses every other pairing, which is what the handler would do (negative)", () => {
    for (const orgRole of ["member", "billing", "compliance", "viewer"]) {
      for (const wsRole of ["billing", "compliance", "viewer"]) {
        expect(canCommandRun(orgRole, wsRole)).toBe(false);
      }
    }
  });

  it("refuses a role value neither membership can hold (negative)", () => {
    expect(canCommandRun("Owner", "Member")).toBe(false);
    expect(canCommandRun("", "")).toBe(false);
  });
});
