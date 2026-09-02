import { describe, expect, it } from "vitest";
import { resellerPricePlanCreate } from "./billing.reseller_price_plan.create";
import { getCapability } from "../registry";

// The mode↔rate cross-check (refinePricingMode) lives on the contract so every
// surface rejects a plan that names a pricing mode without its required rate.
// Exercise the refinement through the contract's own input schema.

describe("create_reseller_price_plan contract", () => {
  it("is registered as a scoped billing capability requiring approval", () => {
    const cap = getCapability("create_reseller_price_plan");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("billing");
    expect(cap?.scoped).toBe(true);
    expect(cap?.agent?.requiresApproval).toBe(true);
    expect(cap?.defaultEffect).toBe("deny");
  });

  describe("pricing-mode refinement", () => {
    it("accepts a markup plan carrying markupBps", () => {
      const parsed = resellerPricePlanCreate.input.parse({
        name: "Standard markup",
        pricingMode: "markup",
        markupBps: 2000,
      });
      expect(parsed.pricingMode).toBe("markup");
      expect(parsed.markupBps).toBe(2000);
      // currency defaults to usd.
      expect(parsed.currency).toBe("usd");
    });

    it("accepts a markupBps of 0 (a 0% markup is still a stated rate)", () => {
      // The guard is `!= null`, so 0 is a legitimate markup rate, not a missing one.
      expect(
        resellerPricePlanCreate.input.safeParse({
          name: "Passthrough",
          pricingMode: "markup",
          markupBps: 0,
        }).success,
      ).toBe(true);
    });

    it("rejects a markup plan with no markupBps", () => {
      const res = resellerPricePlanCreate.input.safeParse({
        name: "Bad markup",
        pricingMode: "markup",
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]?.path).toEqual(["pricingMode"]);
        expect(res.error.issues[0]?.message).toMatch(
          /markup plans require markupBps/,
        );
      }
    });

    it("rejects a markup plan whose markupBps is explicitly null", () => {
      expect(
        resellerPricePlanCreate.input.safeParse({
          name: "Null markup",
          pricingMode: "markup",
          markupBps: null,
        }).success,
      ).toBe(false);
    });

    it("accepts a per_unit plan carrying unitPriceCents", () => {
      const parsed = resellerPricePlanCreate.input.parse({
        name: "Flat per action",
        pricingMode: "per_unit",
        unitPriceCents: 5,
        currency: "EUR",
      });
      expect(parsed.pricingMode).toBe("per_unit");
      expect(parsed.unitPriceCents).toBe(5);
      // currency is lower-cased by the schema transform.
      expect(parsed.currency).toBe("eur");
    });

    it("rejects a per_unit plan with no unitPriceCents", () => {
      const res = resellerPricePlanCreate.input.safeParse({
        name: "Bad per-unit",
        pricingMode: "per_unit",
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]?.message).toMatch(
          /per_unit plans require unitPriceCents/,
        );
      }
    });
  });
});
