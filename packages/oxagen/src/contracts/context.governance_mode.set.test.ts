// The `set_governance_mode` contract: the gate it declares, the shape of the
// override, and the two nullable modes in its answer.
//
// The nullables are the part worth pinning. `previousMode` and `effectiveMode`
// are null when nothing established a mode, and the temptation in both the
// handler and every reader is to substitute `team` — the default a missing file
// falls to at read time. The schema admitting null is what keeps that a read
// rule rather than a claim about what the repository said.
import { describe, expect, it } from "vitest";
import {
  contextGovernanceModeSet,
  GOVERNANCE_BRANCH,
  GOVERNANCE_FILE,
} from "./context.governance_mode.set";
import { GOVERNANCE_MODES } from "./context.steering.shared";

const ANSWER = {
  outcome: "proposed",
  requestedMode: "solo",
  previousMode: "regulated",
  effectiveMode: "regulated",
  fullName: "a-intel/platform",
  productionBranch: "main",
  commitSha: null,
  pullRequest: {
    number: 412,
    htmlUrl: "https://github.com/a-intel/platform/pull/412",
    reused: false,
  },
  overrodeReview: false,
};

describe("set_governance_mode contract", () => {
  it("is a high-sensitivity settings write, unmetered, and approval-gated for agents", () => {
    expect(contextGovernanceModeSet.name).toBe("set_governance_mode");
    expect(contextGovernanceModeSet.mutates).toBe(true);
    // A settings write consumes no credits (ADR-052 exclusion 2).
    expect(contextGovernanceModeSet.noBillingGate).toBe(true);
    expect(contextGovernanceModeSet.sensitivity).toBe("high");
    // An agent that could move its own workspace to solo could then publish
    // its own steering unreviewed.
    expect(contextGovernanceModeSet.agent?.requiresApproval).toBe(true);
    expect(contextGovernanceModeSet.defaultEffect).toBe("deny");
  });

  it("admits the same roles the Edit workspace dialog already admits", () => {
    // The override is offered to everyone who can call this at all, so this
    // pair is what the app relies on to show the checkbox to nobody else.
    expect(contextGovernanceModeSet.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(contextGovernanceModeSet.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("takes each mode, defaults the override to off, and refuses anything else", () => {
    for (const mode of GOVERNANCE_MODES) {
      const parsed = contextGovernanceModeSet.input.safeParse({ mode });
      expect(parsed.success).toBe(true);
      // Absent is off: a caller that never mentions the override never spends
      // it, which is what makes `editWorkspace`'s plain rename safe.
      expect(parsed.success && parsed.data.applyImmediately).toBe(false);
    }
    expect(
      contextGovernanceModeSet.input.safeParse({ mode: "permissive" }).success,
    ).toBe(false);
    expect(contextGovernanceModeSet.input.safeParse({}).success).toBe(false);
    expect(
      contextGovernanceModeSet.input.safeParse({ mode: "solo", force: true })
        .success,
    ).toBe(false);
  });

  it("answers null for a mode nothing established, and never guesses team", () => {
    expect(contextGovernanceModeSet.output.safeParse(ANSWER).success).toBe(
      true,
    );
    // An unreadable or absent governance.toml sent to review: no mode before,
    // and none in force after.
    expect(
      contextGovernanceModeSet.output.safeParse({
        ...ANSWER,
        previousMode: null,
        effectiveMode: null,
      }).success,
    ).toBe(true);
    // `applied` carries the commit and no pull request.
    expect(
      contextGovernanceModeSet.output.safeParse({
        ...ANSWER,
        outcome: "applied",
        effectiveMode: "solo",
        commitSha: "7d2e91a",
        pullRequest: null,
        overrodeReview: true,
      }).success,
    ).toBe(true);
    expect(
      contextGovernanceModeSet.output.safeParse({
        ...ANSWER,
        outcome: "merged",
      }).success,
    ).toBe(false);
    // The pull request is only useful if the person can open it.
    expect(
      contextGovernanceModeSet.output.safeParse({
        ...ANSWER,
        pullRequest: { ...ANSWER.pullRequest, htmlUrl: "412" },
      }).success,
    ).toBe(false);
  });

  it("names the one file and the one branch a proposal uses", () => {
    // Both are exported because the handler writes them and its test asserts
    // them; a second spelling of either would be a bug nothing catches.
    expect(GOVERNANCE_FILE).toBe(".oxagen/rules/governance.toml");
    expect(GOVERNANCE_BRANCH).toBe("oxagen/governance");
  });
});
