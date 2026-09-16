import { describe, expect, it } from "vitest";
import type { AutoApprovalRule } from "@oxagen/oxagen/approval-rules/schemas";
import { MAX_AUTO_APPROVAL_REASONS } from "@oxagen/oxagen/approval-rules/schemas";
import {
  evaluateAutoApproval,
  isFloorReason,
  REASON,
  selectAutoApprovalRule,
  withinBusinessHours,
  type AutoApprovalSubject,
} from "./auto-approval";

const NOW = new Date("2026-09-16T12:00:00.000Z");

function rule(over: Partial<AutoApprovalRule> = {}): AutoApprovalRule {
  return {
    id: "small-vendor-payments",
    name: "Small vendor payments",
    tools: ["stripe__create_payment@*"],
    enabled: true,
    maxMeasures: {},
    allowTargets: {},
    standingWindowMs: null,
    businessHours: null,
    createdBy: "usr_0123456789abcdefghjkmn",
    createdAt: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

function subject(over: Partial<AutoApprovalSubject> = {}): AutoApprovalSubject {
  return {
    capability: "stripe__create_payment",
    tool: {
      slug: "stripe__create_payment",
      version: 3,
      riskGrade: "medium",
      sideEffect: null,
      consequenceTags: ["moves_money"],
      ...(over.tool ?? {}),
    },
    measures: {},
    targets: {},
    tainted: false,
    standingApprovalAt: null,
    now: NOW,
    ...over,
  };
}

describe("selectAutoApprovalRule", () => {
  // The subject builder picks the applicable rule before it finishes building
  // the subject, so it can skip the standing-approval lookup no rule needs.
  // It and evaluateAutoApproval go through this one function on purpose:
  // two copies of the selection would let the rule whose needs decide what is
  // loaded drift from the rule that later judges the call.
  it("is the first enabled rule in authoring order that covers the call", () => {
    const first = rule({ id: "first" });
    const second = rule({ id: "second" });
    expect(selectAutoApprovalRule([first, second], subject())?.id).toBe(
      "first",
    );
    expect(
      selectAutoApprovalRule([{ ...first, enabled: false }, second], subject())
        ?.id,
    ).toBe("second");
    expect(
      selectAutoApprovalRule([rule({ tools: ["linear__*"] })], subject()),
    ).toBeUndefined();
    expect(selectAutoApprovalRule([], subject())).toBeUndefined();
  });

  it("agrees with the rule evaluateAutoApproval reports", () => {
    const rules = [
      { ...rule({ id: "off" }), enabled: false },
      rule({ id: "on" }),
    ];
    expect(selectAutoApprovalRule(rules, subject())?.id).toBe(
      evaluateAutoApproval(rules, subject())?.ruleId,
    );
  });
});

describe("which rule answers", () => {
  it("has no opinion when no rule covers the tool", () => {
    expect(
      evaluateAutoApproval([rule({ tools: ["linear__*"] })], subject()),
    ).toBeNull();
  });

  it("has no opinion when the only covering rule is off", () => {
    expect(
      evaluateAutoApproval([rule({ enabled: false })], subject()),
    ).toBeNull();
  });

  it("answers with the first covering rule in authoring order", () => {
    const out = evaluateAutoApproval(
      [
        rule({ id: "second", tools: ["linear__*"] }),
        rule({ id: "first", name: "First" }),
        rule({ id: "third" }),
      ],
      subject(),
    );
    expect(out).toMatchObject({ ruleId: "first", ruleName: "First", ok: true });
  });

  it("matches a bare slug pattern at every version, and a pinned one only at its own", () => {
    expect(
      evaluateAutoApproval(
        [rule({ tools: ["stripe__create_payment"] })],
        subject(),
      ),
    ).not.toBeNull();
    expect(
      evaluateAutoApproval(
        [rule({ tools: ["stripe__create_payment@2"] })],
        subject(),
      ),
    ).toBeNull();
  });
});

describe("the floors no rule can lift", () => {
  it("refuses a capability with no declared tool, and says there is nothing to judge", () => {
    const out = evaluateAutoApproval([rule({ tools: ["stripe__*"] })], {
      ...subject(),
      tool: null,
    });
    expect(out).toMatchObject({ ok: false, floor: true });
    expect(out?.reasons).toEqual([REASON.toolNotDeclared]);
  });

  it("refuses tainted input", () => {
    const out = evaluateAutoApproval([rule()], subject({ tainted: true }));
    expect(out?.reasons).toEqual([REASON.taintedInput]);
    expect(out?.floor).toBe(true);
  });

  it("refuses a critical hazard", () => {
    const out = evaluateAutoApproval(
      [rule()],
      subject({
        tool: {
          slug: "stripe__create_payment",
          version: 3,
          riskGrade: "critical",
          sideEffect: null,
          consequenceTags: ["moves_money"],
        },
      }),
    );
    expect(out?.reasons).toEqual([REASON.criticalHazard]);
  });

  it("refuses an irreversible consequence", () => {
    const out = evaluateAutoApproval(
      [rule({ tools: ["db__drop_table@*"] })],
      subject({
        capability: "db__drop_table",
        tool: {
          slug: "db__drop_table",
          version: 1,
          riskGrade: "high",
          sideEffect: null,
          consequenceTags: ["alters_production", "destroys_data"],
        },
      }),
    );
    expect(out?.reasons).toEqual([REASON.irreversibleConsequence]);
  });

  it("refuses an irreversible SIDE EFFECT, with or without a tag", () => {
    // `set_tool_classification` names the side-effect class; the consequence
    // tag is the other half of the same statement. Either one is the floor,
    // and it is reported once rather than twice.
    const judge = (sideEffect: string | null, consequenceTags: string[]) =>
      evaluateAutoApproval(
        [rule({ tools: ["db__drop_table@*"] })],
        subject({
          capability: "db__drop_table",
          tool: {
            slug: "db__drop_table",
            version: 1,
            riskGrade: "high",
            sideEffect,
            consequenceTags,
          },
        }),
      );
    expect(judge("irreversible", [])?.reasons).toEqual([
      REASON.irreversibleConsequence,
    ]);
    expect(judge("irreversible", ["destroys_data"])?.reasons).toEqual([
      REASON.irreversibleConsequence,
    ]);
    expect(judge(null, ["destroys_data"])?.reasons).toEqual([
      REASON.irreversibleConsequence,
    ]);
    expect(judge("write", [])?.reasons).toEqual([]);
    expect(judge(null, [])?.reasons).toEqual([]);
  });

  it("refuses whatever a rule with no conditions says, and reports every floor at once", () => {
    const out = evaluateAutoApproval(
      [rule()],
      subject({
        tainted: true,
        tool: {
          slug: "stripe__create_payment",
          version: 3,
          riskGrade: "critical",
          sideEffect: null,
          consequenceTags: ["destroys_data"],
        },
      }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.reasons).toEqual([
      REASON.taintedInput,
      REASON.criticalHazard,
      REASON.irreversibleConsequence,
    ]);
  });

  it("marks a floor reason as a floor and a rule's own as not", () => {
    expect(isFloorReason(REASON.taintedInput)).toBe(true);
    expect(isFloorReason(`${REASON.measureAboveCeiling}:amount`)).toBe(false);
  });
});

describe("a measure under a threshold", () => {
  it("admits a value at the ceiling and refuses one above it", () => {
    const capped = [rule({ maxMeasures: { amount: "250000000" } })];
    expect(
      evaluateAutoApproval(
        capped,
        subject({ measures: { amount: "250000000" } }),
      ),
    ).toMatchObject({ ok: true });
    const over = evaluateAutoApproval(
      capped,
      subject({ measures: { amount: "250000001" } }),
    );
    expect(over).toMatchObject({ ok: false, floor: false });
    expect(over?.reasons).toEqual([`${REASON.measureAboveCeiling}:amount`]);
  });

  it("refuses a call that does not carry the measure the rule caps", () => {
    const out = evaluateAutoApproval(
      [rule({ maxMeasures: { amount: "1" } })],
      subject(),
    );
    expect(out?.reasons).toEqual([`${REASON.measureUnreadable}:amount`]);
  });

  it("reports the measures in name order whatever order they were stored in", () => {
    const out = evaluateAutoApproval(
      [rule({ maxMeasures: { rows: "1", amount: "1" } })],
      subject(),
    );
    expect(out?.reasons).toEqual([
      `${REASON.measureUnreadable}:amount`,
      `${REASON.measureUnreadable}:rows`,
    ]);
  });
});

describe("a counterparty or environment on an allow list", () => {
  it("admits a target the list names and refuses one it does not", () => {
    const listed = [rule({ allowTargets: { counterparty: ["vendor:*"] } })];
    expect(
      evaluateAutoApproval(
        listed,
        subject({ targets: { counterparty: "vendor:aws" } }),
      ),
    ).toMatchObject({ ok: true });
    const out = evaluateAutoApproval(
      listed,
      subject({ targets: { counterparty: "person:anyone" } }),
    );
    expect(out?.reasons).toEqual([`${REASON.targetNotAllowed}:counterparty`]);
  });

  it("refuses a call that does not carry the target the rule allow-lists", () => {
    const out = evaluateAutoApproval(
      [rule({ allowTargets: { environment: ["staging"] } })],
      subject(),
    );
    expect(out?.reasons).toEqual([`${REASON.targetUnreadable}:environment`]);
  });
});

describe("a standing approval", () => {
  const standing = [rule({ standingWindowMs: 24 * 60 * 60 * 1000 })];

  it("admits a person's approval of the same digest inside the window", () => {
    expect(
      evaluateAutoApproval(
        standing,
        subject({ standingApprovalAt: new Date("2026-09-15T13:00:00.000Z") }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("refuses one at the edge of the window and one that never happened", () => {
    expect(
      evaluateAutoApproval(
        standing,
        subject({ standingApprovalAt: new Date("2026-09-15T11:59:59.999Z") }),
      )?.reasons,
    ).toEqual([REASON.noStandingApproval]);
    expect(evaluateAutoApproval(standing, subject())?.reasons).toEqual([
      REASON.noStandingApproval,
    ]);
  });

  it("admits one exactly at the window's edge", () => {
    expect(
      evaluateAutoApproval(
        standing,
        subject({ standingApprovalAt: new Date("2026-09-15T12:00:00.000Z") }),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("business hours", () => {
  const officeHours = {
    timezone: "America/New_York",
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "17:00",
  };
  const hours = [rule({ businessHours: officeHours })];

  it("admits a call inside the window and refuses one outside it", () => {
    // 2026-09-16 is a Wednesday. 14:00Z is 10:00 in New York (EDT); the
    // default clock of 12:00Z is 08:00 there, an hour before the window opens.
    expect(
      evaluateAutoApproval(
        hours,
        subject({ now: new Date("2026-09-16T14:00:00.000Z") }),
      ),
    ).toMatchObject({ ok: true });
    expect(evaluateAutoApproval(hours, subject())?.reasons).toEqual([
      REASON.outsideBusinessHours,
    ]);
    expect(
      evaluateAutoApproval(
        hours,
        subject({ now: new Date("2026-09-16T02:00:00.000Z") }),
      )?.reasons,
    ).toEqual([REASON.outsideBusinessHours]);
  });

  it("refuses a day the rule does not name", () => {
    // 2026-09-19 is a Saturday.
    expect(
      evaluateAutoApproval(
        hours,
        subject({ now: new Date("2026-09-19T14:00:00.000Z") }),
      )?.reasons,
    ).toEqual([REASON.outsideBusinessHours]);
  });

  it("keeps the same local window on both sides of a daylight-saving change", () => {
    // 13:30Z is 09:30 in New York on 2026-10-30 (EDT, UTC-4) and 08:30 on
    // 2026-11-06 (EST, UTC-5). A window read in UTC would admit both.
    const before = new Date("2026-10-30T13:30:00.000Z");
    const after = new Date("2026-11-06T13:30:00.000Z");
    expect(withinBusinessHours(before, officeHours)).toBe(true);
    expect(withinBusinessHours(after, officeHours)).toBe(false);
    // And the hour that used to be outside is inside once the clocks change.
    expect(
      withinBusinessHours(new Date("2026-11-06T14:30:00.000Z"), officeHours),
    ).toBe(true);
  });

  it("reads midnight as the first minute of the day, not the last", () => {
    expect(
      withinBusinessHours(new Date("2026-09-16T00:30:00.000Z"), {
        timezone: "UTC",
        days: [1, 2, 3, 4, 5],
        start: "00:00",
        end: "01:00",
      }),
    ).toBe(true);
  });
});

describe("the conditions together", () => {
  it("records every reason a call did not qualify, floors first", () => {
    const out = evaluateAutoApproval(
      [
        rule({
          maxMeasures: { amount: "1000000" },
          allowTargets: { counterparty: ["vendor:aws"] },
          standingWindowMs: 60_000,
        }),
      ],
      subject({
        tainted: true,
        measures: { amount: "9000000" },
        targets: { counterparty: "vendor:github" },
      }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.floor).toBe(true);
    expect(out?.reasons).toEqual([
      REASON.taintedInput,
      `${REASON.measureAboveCeiling}:amount`,
      `${REASON.targetNotAllowed}:counterparty`,
      REASON.noStandingApproval,
    ]);
  });

  it("qualifies only when every condition holds", () => {
    expect(
      evaluateAutoApproval(
        [
          rule({
            maxMeasures: { amount: "250000000" },
            allowTargets: { counterparty: ["vendor:*"] },
            standingWindowMs: 24 * 60 * 60 * 1000,
            businessHours: {
              timezone: "UTC",
              days: [1, 2, 3, 4, 5],
              start: "09:00",
              end: "17:00",
            },
          }),
        ],
        subject({
          measures: { amount: "12500000" },
          targets: { counterparty: "vendor:aws" },
          standingApprovalAt: new Date("2026-09-16T09:00:00.000Z"),
        }),
      ),
    ).toEqual({
      ruleId: "small-vendor-payments",
      ruleName: "Small vendor payments",
      ok: true,
      reasons: [],
      floor: false,
    });
  });
});

describe("the recorded reason list stays readable", () => {
  it("never grows past what the output schema accepts, even at the authored maximum", () => {
    // A rule may cap 16 measures and allow-list 16 targets; the call carries
    // none of them, and every floor fires too. That is the worst case, and it
    // must still parse back through `autoEligibilitySchema`.
    const sixteen = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`${prefix}_${i}`, "0"]),
      );
    const out = evaluateAutoApproval(
      [
        rule({
          maxMeasures: sixteen("m"),
          allowTargets: Object.fromEntries(
            Object.keys(sixteen("t")).map((k) => [k, ["nothing"]]),
          ),
          standingWindowMs: 60_000,
          businessHours: {
            timezone: "UTC",
            days: [1],
            start: "09:00",
            end: "17:00",
          },
        }),
      ],
      subject({
        tainted: true,
        now: new Date("2026-09-19T03:00:00.000Z"),
        tool: {
          slug: "stripe__create_payment",
          version: 3,
          riskGrade: "critical",
          sideEffect: null,
          consequenceTags: ["destroys_data"],
        },
      }),
    );
    expect(out?.reasons).toHaveLength(37);
    expect(out!.reasons.length).toBeLessThanOrEqual(MAX_AUTO_APPROVAL_REASONS);
  });
});
