import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSEQUENCE_ROLES,
  effectiveConsequenceRoles,
  mandateApproverSchema,
  mandateBodySchema,
  mandateLimitsSchema,
  measureDeclarationSchema,
  measureValueSchema,
  rolesForConsequence,
} from "./schemas";
import { SPEC_MANDATE_BODY as BODY } from "./schemas.sample";

describe("consequence roles", () => {
  it("answers an override before the default, and the default before `other`", () => {
    expect(rolesForConsequence("moves_money", {})).toEqual([
      "Owner",
      "Billing",
    ]);
    expect(
      rolesForConsequence("moves_money", { moves_money: ["Billing"] }),
    ).toEqual(["Billing"]);
    expect(rolesForConsequence("ships_code", {})).toEqual(
      DEFAULT_CONSEQUENCE_ROLES.other,
    );
  });

  it("the effective map covers every starter tag plus the workspace's own", () => {
    const map = effectiveConsequenceRoles({ ships_code: ["Admin"] });
    expect(Object.keys(map).sort()).toEqual([
      "alters_production",
      "changes_access",
      "changes_entitlement",
      "communicates_externally",
      "destroys_data",
      "moves_money",
      "ships_code",
    ]);
    expect(map.ships_code).toEqual(["Admin"]);
    expect("other" in map).toBe(false);
  });
});

describe("measure values", () => {
  it.each(["0", "1", "250000000"])("accepts the integer string %s", (v) => {
    expect(measureValueSchema.safeParse(v).success).toBe(true);
  });
  it.each(["-1", "1.5", "01", "1e6", 250000000, ""])("refuses %j", (v) => {
    expect(measureValueSchema.safeParse(v).success).toBe(false);
  });
  it("a measure declaration names a path, a type and a unit; scale is for amounts", () => {
    expect(
      measureDeclarationSchema.safeParse({
        path: "amount.value",
        type: "amount",
        unit: "USD",
        scale: 2,
      }).success,
    ).toBe(true);
    expect(
      measureDeclarationSchema.safeParse({
        path: "rows",
        type: "count",
        unit: "rows",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      measureDeclarationSchema.safeParse({
        path: "x",
        type: "amount",
        unit: "USD",
        scale: 7,
      }).success,
    ).toBe(false);
  });
});

describe("the mandate body", () => {
  it("parses the spec's shape", () => {
    const parsed = mandateBodySchema.parse(BODY);
    expect(parsed.limits.amount?.perCall).toBe("250000000");
    expect(parsed.approval.approvers).toEqual(["role:Billing"]);
  });
  it("defaults targets and the approval rule", () => {
    const { targets: _t, approval: _a, ...rest } = BODY;
    const parsed = mandateBodySchema.parse(rest);
    expect(parsed.targets).toEqual({});
    expect(parsed.approval).toEqual({
      humanAbove: {},
      alwaysHumanFor: [],
      approvers: [],
    });
  });
  it("admits an approver as an org role or a user public id, and nothing else", () => {
    for (const ok of ["role:Owner", "role:Billing", "user:usr_01k5rt9xq7"]) {
      expect(mandateApproverSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      "role:Member",
      "role:org.billing",
      "user:u_1",
      "Billing",
      "team:finance",
    ]) {
      expect(mandateApproverSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("refuses a limit with neither perCall nor perPeriod, and an empty limit set", () => {
    expect(
      mandateLimitsSchema.safeParse({
        amount: { period: "monthly", currencyOrUnit: "USD" },
      }).success,
    ).toBe(false);
    expect(mandateLimitsSchema.safeParse({}).success).toBe(false);
  });
  it("refuses validTo at or before validFrom, no tag, no tool, and an unknown field", () => {
    expect(
      mandateBodySchema.safeParse({ ...BODY, validTo: "2026-09-01T00:00:00Z" })
        .success,
    ).toBe(false);
    expect(
      mandateBodySchema.safeParse({ ...BODY, consequenceTags: [] }).success,
    ).toBe(false);
    expect(mandateBodySchema.safeParse({ ...BODY, tools: [] }).success).toBe(
      false,
    );
    expect(
      mandateBodySchema.safeParse({ ...BODY, twoPerson: true }).success,
    ).toBe(false);
  });
  it("binds to an agent public id, never a uuid", () => {
    expect(
      mandateBodySchema.safeParse({
        ...BODY,
        agentId: "0195b7c8-1e6e-7c3a-9f0e-0a1b2c3d4e5f",
      }).success,
    ).toBe(false);
  });
});
