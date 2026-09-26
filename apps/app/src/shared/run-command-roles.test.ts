// The rules the run controls gate on, each held to its contract's own
// `defaultRoles`: `dispatch_command` admits an org Owner or Admin, or a
// workspace Owner or Member; `seal_run` admits the org's and the workspace
// Owner only (ADR-169).
//
// `fork_run` holds to its handler's check (`FORK_ROLES` in
// packages/handlers/src/run.fork.ts): an organization Owner, Admin or Member,
// whatever the workspace role.
import { describe, expect, it } from "vitest";
import { canCommandRun, canForkRun, canSealRun } from "./run-command-roles";

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

describe("canSealRun", () => {
  it("admits an organization Owner or Admin whatever the workspace role is", () => {
    expect(canSealRun("owner", "viewer")).toBe(true);
    expect(canSealRun("admin", "viewer")).toBe(true);
  });

  it("admits the workspace Owner whose organization role is only Viewer", () => {
    expect(canSealRun("viewer", "owner")).toBe(true);
  });

  it("refuses a workspace Member, who can cancel but not seal (negative)", () => {
    expect(canCommandRun("viewer", "member")).toBe(true);
    expect(canSealRun("viewer", "member")).toBe(false);
    for (const orgRole of ["member", "billing", "compliance", "viewer"]) {
      for (const wsRole of ["member", "billing", "compliance", "viewer"]) {
        expect(canSealRun(orgRole, wsRole)).toBe(false);
      }
    }
  });
});

describe("canForkRun", () => {
  it("admits an organization Owner, Admin or Member", () => {
    expect(canForkRun("owner")).toBe(true);
    expect(canForkRun("admin")).toBe(true);
    expect(canForkRun("member")).toBe(true);
  });

  it("refuses every other organization role, which is what fork_run would do (negative)", () => {
    for (const orgRole of ["billing", "compliance", "viewer"]) {
      expect(canForkRun(orgRole)).toBe(false);
    }
  });

  it("refuses an organization Viewer who owns the workspace, because the handler reads no workspace role (negative)", () => {
    // The Viewer can command the run through the workspace role, and still
    // cannot fork it.
    expect(canCommandRun("viewer", "owner")).toBe(true);
    expect(canForkRun("viewer")).toBe(false);
  });

  it("refuses a role value the membership cannot hold (negative)", () => {
    expect(canForkRun("Owner")).toBe(false);
    expect(canForkRun("")).toBe(false);
  });
});
