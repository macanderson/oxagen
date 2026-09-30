import { describe, expect, it } from "vitest";
import {
  STEERING_IMPORT_OUTCOMES,
  steeringRepoImport,
} from "./steering_repo.import";

const imported = {
  outcome: "imported",
  steeringRepository: "a-intel/platform-steering",
  pullRequests: [
    { branch: "steering/import-oxagen", number: 519, url: "https://github.com/a-intel/platform-steering/pull/519" },
  ],
  cleanup: { number: 88, url: "https://github.com/a-intel/platform/pull/88" },
  leftForAPerson: 2,
  rulesNeedingKind: [],
  constraintsNeedingEffect: [],
};

describe("import_workspace_steering contract", () => {
  it("is a high-sensitivity workspace write on api and mcp, outside metering", () => {
    expect(steeringRepoImport.name).toBe("import_workspace_steering");
    expect(steeringRepoImport.scoped).toBe(true);
    expect(steeringRepoImport.mutates).toBe(true);
    expect(steeringRepoImport.noBillingGate).toBe(true);
    expect(steeringRepoImport.sensitivity).toBe("high");
    expect(steeringRepoImport.surfaces).toEqual(["api", "mcp"]);
  });

  it("is for org Owners and Admins and workspace Owners", () => {
    expect(steeringRepoImport.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
  });

  it("is a one-time move a person starts, off the agent surface", () => {
    expect(steeringRepoImport.surfaces).not.toContain("agent");
    expect("agent" in steeringRepoImport).toBe(false);
  });

  it("takes an empty input or the choices for v0.1 rules and constraints", () => {
    expect(steeringRepoImport.input.parse({})).toEqual({});
    const choices = {
      ruleKinds: { "rule-a": "business-rule", "rule-b": "code-rule" },
      constraintEffects: { "constraint-a": "require", "constraint-b": "forbid" },
    };
    expect(steeringRepoImport.input.parse(choices)).toEqual(choices);
  });

  it("takes startFresh for a workspace on a legacy sources connection", () => {
    expect(steeringRepoImport.input.parse({ startFresh: true })).toEqual({
      startFresh: true,
    });
    expect(
      steeringRepoImport.input.safeParse({ startFresh: "yes" }).success,
    ).toBe(false);
  });

  it("refuses an unknown kind, an unknown effect, and an unknown field", () => {
    expect(
      steeringRepoImport.input.safeParse({ ruleKinds: { a: "rule" } }).success,
    ).toBe(false);
    expect(
      steeringRepoImport.input.safeParse({ constraintEffects: { a: "allow" } })
        .success,
    ).toBe(false);
    expect(steeringRepoImport.input.safeParse({ force: true }).success).toBe(false);
  });

  it("answers each outcome", () => {
    for (const outcome of STEERING_IMPORT_OUTCOMES)
      expect(steeringRepoImport.output.parse({ ...imported, outcome }).outcome).toBe(
        outcome,
      );
    expect(
      steeringRepoImport.output.safeParse({ ...imported, outcome: "skipped" }).success,
    ).toBe(false);
  });

  it("answers a workspace with no steering repo and no cleanup PR", () => {
    const needsChoices = {
      ...imported,
      outcome: "needs_choices",
      steeringRepository: null,
      pullRequests: [],
      cleanup: null,
      leftForAPerson: 0,
      rulesNeedingKind: ["rule-a"],
      constraintsNeedingEffect: ["constraint-a"],
    };
    expect(steeringRepoImport.output.parse(needsChoices)).toEqual(needsChoices);
  });

  it("refuses a negative count", () => {
    expect(
      steeringRepoImport.output.safeParse({ ...imported, leftForAPerson: -1 }).success,
    ).toBe(false);
  });
});
