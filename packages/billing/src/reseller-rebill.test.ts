import { describe, it, expect } from "vitest";
import { buildPreviews } from "./reseller-rebill";
import type { ResolvedPlan } from "./reseller";
import type { ResellerUsageSlice } from "@oxagen/telemetry";

// buildPreviews is pure over drizzle row shapes; construct minimal rows and cast.
type AnyCustomer = Parameters<typeof buildPreviews>[0][number];
function customer(
  id: string,
  publicId: string,
  name: string,
  pricePlanId: string | null,
): AnyCustomer {
  return { id, publicId, name, pricePlanId } as unknown as AnyCustomer;
}

type Rule = Parameters<typeof buildPreviews>[2][number];
function rule(
  customerId: string,
  kind: Rule["matchKind"],
  value: string,
  label: string,
  priority = 100,
): Rule {
  return {
    customerId,
    matchKind: kind,
    matchValue: value,
    matchLabel: label,
    priority,
  };
}

function slice(
  workspaceId: string,
  principalId: string,
  capabilityName: string,
  costMicros: number,
  executions: number,
): ResellerUsageSlice {
  return {
    workspaceId,
    principalId,
    capabilityName,
    principalKind: "human",
    costMicros,
    executions,
  };
}

const markupPlan: ResolvedPlan = {
  internalId: "plan-uuid",
  publicId: "resplan_1",
  name: "20% markup",
  currency: "usd",
  rate: { pricingMode: "markup", markupBps: 2000, unitPriceCents: null },
};
const perUnitPlan: ResolvedPlan = {
  internalId: "plan-uuid-2",
  publicId: "resplan_2",
  name: "1c per unit",
  currency: "usd",
  rate: { pricingMode: "per_unit", markupBps: null, unitPriceCents: 1 },
};

describe("buildPreviews", () => {
  it("attributes a matched slice to a customer and prices it with markup", () => {
    const customers = [customer("c1", "rescus_1", "Acme", "plan-uuid")];
    const plans = new Map([["plan-uuid", markupPlan]]);
    const rules = [rule("c1", "workspace", "ws-1", "Acme workspace")];
    // 1,000,000 micros = $1.00 = 100 cents raw; ×1.2 = 120 cents.
    const slices = [slice("ws-1", "p1", "run_agent", 1_000_000, 4)];

    const { previews, unattributedCostCents } = buildPreviews(
      customers,
      plans,
      rules,
      slices,
    );
    expect(unattributedCostCents).toBe(0);
    expect(previews).toHaveLength(1);
    const p = previews[0]!;
    expect(p.customerId).toBe("rescus_1");
    expect(p.pricePlanName).toBe("20% markup");
    expect(p.subtotalCents).toBe(100);
    expect(p.totalCents).toBe(120);
    expect(p.lineItems).toHaveLength(1);
    expect(p.lineItems[0]!).toMatchObject({
      label: "Acme workspace",
      matchKind: "workspace",
      rawCostCents: 100,
      quantity: 4,
      amountCents: 120,
      unitPriceCents: null,
    });
  });

  it("prices per_unit plans by attributed executions", () => {
    const customers = [customer("c1", "rescus_1", "Acme", "plan-uuid-2")];
    const plans = new Map([["plan-uuid-2", perUnitPlan]]);
    const rules = [rule("c1", "capability", "run_agent", "Agent runs")];
    const slices = [slice("ws-1", "p1", "run_agent", 500_000, 7)];

    const { previews } = buildPreviews(customers, plans, rules, slices);
    const p = previews[0]!;
    // 1c × 7 executions = 7 cents billed; subtotal is the raw cost (50c).
    expect(p.subtotalCents).toBe(50);
    expect(p.totalCents).toBe(7);
    expect(p.lineItems[0]!.unitPriceCents).toBe(1);
  });

  it("aggregates multiple slices matching the same rule into one line", () => {
    const customers = [customer("c1", "rescus_1", "Acme", "plan-uuid")];
    const plans = new Map([["plan-uuid", markupPlan]]);
    const rules = [rule("c1", "workspace", "ws-1", "Acme workspace")];
    const slices = [
      slice("ws-1", "p1", "run_agent", 300_000, 2),
      slice("ws-1", "p2", "summarize", 700_000, 3),
    ];
    const { previews } = buildPreviews(customers, plans, rules, slices);
    const p = previews[0]!;
    expect(p.lineItems).toHaveLength(1);
    expect(p.lineItems[0]!.rawCostCents).toBe(100); // (300k+700k)/10k
    expect(p.lineItems[0]!.quantity).toBe(5);
  });

  it("routes usage matched by no rule into the unattributed bucket", () => {
    const customers = [customer("c1", "rescus_1", "Acme", "plan-uuid")];
    const plans = new Map([["plan-uuid", markupPlan]]);
    const rules = [rule("c1", "workspace", "ws-1", "Acme workspace")];
    const slices = [
      slice("ws-1", "p1", "run_agent", 1_000_000, 1), // matched
      slice("ws-OTHER", "p9", "misc", 2_000_000, 1), // unmatched
    ];
    const { previews, unattributedCostCents } = buildPreviews(
      customers,
      plans,
      rules,
      slices,
    );
    expect(previews[0]!.subtotalCents).toBe(100);
    expect(unattributedCostCents).toBe(200); // 2,000,000 micros = 200 cents
  });

  it("excludes usage attributed to a customer outside the target set (not unattributed)", () => {
    // Only c1 is in scope; a rule points ws-2 → c2 (out of scope).
    const customers = [customer("c1", "rescus_1", "Acme", "plan-uuid")];
    const plans = new Map([["plan-uuid", markupPlan]]);
    const rules = [
      rule("c1", "workspace", "ws-1", "Acme"),
      rule("c2", "workspace", "ws-2", "Other customer"),
    ];
    const slices = [slice("ws-2", "p1", "run_agent", 5_000_000, 1)];
    const { previews, unattributedCostCents } = buildPreviews(
      customers,
      plans,
      rules,
      slices,
    );
    expect(previews[0]!.totalCents).toBe(0); // c1 got nothing
    expect(unattributedCostCents).toBe(0); // ws-2 matched c2, so not unattributed
  });

  it("passes usage through at cost for a customer with no plan", () => {
    const customers = [customer("c1", "rescus_1", "Acme", null)];
    const plans = new Map<string, ResolvedPlan>();
    const rules = [rule("c1", "principal", "p1", "Agent p1")];
    const slices = [slice("ws-1", "p1", "run_agent", 1_000_000, 2)];
    const { previews } = buildPreviews(customers, plans, rules, slices);
    const p = previews[0]!;
    expect(p.pricePlanId).toBeNull();
    expect(p.subtotalCents).toBe(100);
    expect(p.totalCents).toBe(100); // pass-through
    expect(p.currency).toBe("usd");
  });
});
