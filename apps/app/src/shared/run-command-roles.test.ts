// The rules the run controls gate on, each held to its contract's own
// `defaultRoles`: `dispatch_command` admits an org Owner or Admin, or a
// workspace Owner or Member; `seal_run` admits the org's and the workspace
// Owner only (ADR-169); a path answer to a repository question admits the
// same pair `link_repository` and `create_workspace` do (#3941).
import { describe, expect, it } from "vitest";
import {
  canAnswerRepositoryQuestion,
  canCommandRun,
  canSealRun,
} from "./run-command-roles";

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

describe("canAnswerRepositoryQuestion", () => {
  it("admits an organization Owner or Admin whatever the workspace role is", () => {
    expect(canAnswerRepositoryQuestion("owner", "viewer")).toBe(true);
    expect(canAnswerRepositoryQuestion("admin", "viewer")).toBe(true);
  });

  it("admits the workspace Owner whose organization role is only Viewer", () => {
    expect(canAnswerRepositoryQuestion("viewer", "owner")).toBe(true);
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
    expect(canAnswerRepositoryQuestion("Owner", "Owner")).toBe(false);
    expect(canAnswerRepositoryQuestion("", "")).toBe(false);
  });
});
