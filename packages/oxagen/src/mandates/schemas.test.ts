import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSEQUENCE_ROLES,
  effectiveConsequenceRoles,
  isIso4217Currency,
  mandateApproverSchema,
  mandateBodySchema,
  mandateLimitChangesSchema,
  mandateLimitsSchema,
  measureDeclarationReadSchema,
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

  // #3448 (residue from #3442, ADR-111): an `amount` measure's unit must be
  // ISO 4217, refused here rather than passing this schema, the grant-time
  // unit-match check and only failing later at `Money.safeParse`, taking
  // every mandate naming the measure down with it (`record_unmappable`).
  it("refuses a non-ISO-4217 unit on an amount measure", () => {
    const result = measureDeclarationSchema.safeParse({
      path: "amount.value",
      type: "amount",
      unit: "USDC",
      scale: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["unit"]);
      expect(result.error.issues[0]?.message).toMatch(/ISO 4217/);
    }
  });

  it("accepts a count measure denominated in a currency-code unit", () => {
    // ADR-108's own example: a count of dollar bills, not an amount of
    // dollars. The ISO 4217 constraint applies only to `type: "amount"`.
    expect(
      measureDeclarationSchema.safeParse({
        path: "bills",
        type: "count",
        unit: "USD",
      }).success,
    ).toBe(true);
  });

  it("accepts a count measure denominated in an arbitrary, non-ISO unit", () => {
    expect(
      measureDeclarationSchema.safeParse({
        path: "amount.value",
        type: "count",
        unit: "USDC",
      }).success,
    ).toBe(true);
  });

  // Codex review on #3484: the write-time ISO 4217 check must not also
  // apply to a READ of an already-persisted declaration. A tool published
  // before ADR-111 can still carry a legacy `{ type: "amount", unit: "USDC"
  // }` on disk, and `loadDeclaredTool` parses every enabled tool's
  // `tool_versions.measures` on every mandate-gated call. Refusing that read
  // would take the tool down instead of only failing to map it for the
  // app's Money-typed surfaces.
  it("the read schema accepts a legacy non-ISO-4217 unit on a stored amount measure", () => {
    const stored = {
      path: "amount.value",
      type: "amount" as const,
      unit: "USDC",
      scale: 2,
    };
    expect(measureDeclarationSchema.safeParse(stored).success).toBe(false);
    expect(measureDeclarationReadSchema.safeParse(stored).success).toBe(true);
  });

  it.each([
    "USD",
    "EUR",
    "JPY",
    "GBP",
    "CLF",
    "CHE",
    "USN",
    "XAU",
    "XCG",
    "ZWG",
  ])("isIso4217Currency accepts %s", (code) => {
    expect(isIso4217Currency(code)).toBe(true);
  });

  it.each(["USDC", "GAU", "RPM", "xyz", ""])(
    "isIso4217Currency refuses %j",
    (code) => {
      expect(isIso4217Currency(code)).toBe(false);
    },
  );
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
  // A change is partial by design (ADR-102), so the one thing it must refuse is
  // saying nothing: an empty set, or a measure whose change carries no field.
  // Every field it does carry is held to the same rules a stored bound is.
  it("takes a partial bound as a change, and refuses one that says nothing", () => {
    expect(
      mandateLimitChangesSchema.safeParse({ amount: { perPeriod: "500" } })
        .success,
    ).toBe(true);
    expect(
      mandateLimitChangesSchema.safeParse({ amount: { period: "weekly" } })
        .success,
    ).toBe(true);
    expect(mandateLimitChangesSchema.safeParse({}).success).toBe(false);
    expect(mandateLimitChangesSchema.safeParse({ amount: {} }).success).toBe(
      false,
    );
    expect(
      mandateLimitChangesSchema.safeParse({ amount: { perPeriod: "5.5" } })
        .success,
    ).toBe(false);
    expect(
      mandateLimitChangesSchema.safeParse({ amount: { period: "yearly" } })
        .success,
    ).toBe(false);
    expect(
      mandateLimitChangesSchema.safeParse({
        amount: { perPeriod: "500", surprise: true },
      }).success,
    ).toBe(false);
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
