// The rules the run controls gate on, each held to its contract's own
// `defaultRoles` plus the workspace Owner and Admin rule (#5228):
// `dispatch_command` admits an org Owner or Admin, or a workspace Owner,
// Admin or Member; `seal_run` admits the org's and the workspace's Owner and
// Admin (ADR-169); a path answer to a repository question admits the same
// pair `link_repository` admits (#3941).
//
// `fork_run` holds to its handler's check (`FORK_ROLES` in
// packages/handlers/src/run.fork.ts): an organization Owner, Admin or Member,
// or the workspace's Owner or Admin.
import { describe, expect, it } from "vitest";
import {
  canAnswerRepositoryQuestion,
  canCommandRun,
  canForkRun,
  canSealRun,
} from "./run-command-roles";

describe("canCommandRun", () => {
  it("admits an organization Owner or Admin whatever the workspace role is", () => {
    expect(canCommandRun("owner", "viewer")).toBe(true);
    expect(canCommandRun("admin", "viewer")).toBe(true);
  });

  it("admits a workspace Owner, Admin or Member whose organization role is only Viewer", () => {
    expect(canCommandRun("viewer", "owner")).toBe(true);
    expect(canCommandRun("viewer", "admin")).toBe(true);
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

  it("admits the workspace Owner or Admin whose organization role is only Viewer", () => {
    expect(canSealRun("viewer", "owner")).toBe(true);
    expect(canSealRun("viewer", "admin")).toBe(true);
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

describe("canAnswerRepositoryQuestion", () => {
  it("admits an organization Owner or Admin whatever the workspace role is", () => {
    expect(canAnswerRepositoryQuestion("owner", "viewer")).toBe(true);
    expect(canAnswerRepositoryQuestion("admin", "viewer")).toBe(true);
  });

  it("admits the workspace Owner or Admin whose organization role is only Viewer", () => {
    expect(canAnswerRepositoryQuestion("viewer", "owner")).toBe(true);
    expect(canAnswerRepositoryQuestion("viewer", "admin")).toBe(true);
  });

  it("refuses a workspace Member, whom the handler refuses a path answer (negative)", () => {
    expect(canAnswerRepositoryQuestion("viewer", "member")).toBe(false);
    expect(canAnswerRepositoryQuestion("member", "member")).toBe(false);
    for (const orgRole of ["member", "billing", "compliance", "viewer"]) {
      for (const wsRole of ["member", "billing", "compliance", "viewer"]) {
        expect(canAnswerRepositoryQuestion(orgRole, wsRole)).toBe(false);
      }
    }
  });

  it("refuses a role value neither membership can hold (negative)", () => {
    expect(canAnswerRepositoryQuestion("Owner", "Member")).toBe(false);
    expect(canAnswerRepositoryQuestion("", "")).toBe(false);
  });
});

describe("canForkRun", () => {
  it("admits an organization Owner, Admin or Member", () => {
    expect(canForkRun("owner", "viewer")).toBe(true);
    expect(canForkRun("admin", "viewer")).toBe(true);
    expect(canForkRun("member", "viewer")).toBe(true);
  });

  it("admits the workspace Owner or Admin whose organization role is only Viewer", () => {
    expect(canForkRun("viewer", "owner")).toBe(true);
    expect(canForkRun("viewer", "admin")).toBe(true);
  });

  it("refuses every other pairing, which is what fork_run would do (negative)", () => {
    for (const orgRole of ["billing", "compliance", "viewer"]) {
      for (const wsRole of ["member", "billing", "compliance", "viewer"]) {
        expect(canForkRun(orgRole, wsRole)).toBe(false);
      }
    }
  });

  it("refuses an organization Viewer who is a workspace Member, though they can command the run (negative)", () => {
    expect(canCommandRun("viewer", "member")).toBe(true);
    expect(canForkRun("viewer", "member")).toBe(false);
  });

  it("refuses a role value the membership cannot hold (negative)", () => {
    expect(canForkRun("Owner", "Member")).toBe(false);
    expect(canForkRun("", "")).toBe(false);
  });
});
