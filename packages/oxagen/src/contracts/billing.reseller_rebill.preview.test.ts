import { describe, expect, it } from "vitest";
import { resellerRebillPreview } from "./billing.reseller_rebill.preview";
import { getCapability } from "../registry";

describe("preview_reseller_rebill capability", () => {
  it("parses a valid input for a bounded period", () => {
    const parsed = resellerRebillPreview.input.parse({
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-31T00:00:00Z",
    });

    expect(parsed.start).toBe("2026-07-01T00:00:00Z");
    expect(parsed.customerId).toBeUndefined();
  });

  it("accepts an optional customerId to preview a single customer", () => {
    const parsed = resellerRebillPreview.input.parse({
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-31T00:00:00Z",
      customerId: "cust_1",
    });

    expect(parsed.customerId).toBe("cust_1");
  });

  it("rejects an end before start", () => {
    expect(() =>
      resellerRebillPreview.input.parse({
        start: "2026-07-31T00:00:00Z",
        end: "2026-07-01T00:00:00Z",
      }),
    ).toThrow("end must be after start");
  });

  it("rejects a period longer than 366 days", () => {
    expect(() =>
      resellerRebillPreview.input.parse({
        start: "2020-01-01T00:00:00Z",
        end: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("period must not exceed 366 days");
  });

  it("parses a valid output", () => {
    const out = resellerRebillPreview.output.parse({
      range: { start: "2026-07-01T00:00:00Z", end: "2026-07-31T00:00:00Z" },
      previews: [
        {
          customerId: "cust_1",
          customerName: "Acme",
          pricePlanId: "plan_1",
          pricePlanName: "Standard",
          currency: "usd",
          subtotalCents: 1000,
          totalCents: 1500,
          lineItems: [],
        },
      ],
      unattributedCostCents: 0,
    });

    expect(out.previews).toHaveLength(1);
    expect(out.unattributedCostCents).toBe(0);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("preview_reseller_rebill")).toBe(
      resellerRebillPreview,
    );
// The billing-period bounds are enforced by two chained `.refine()` predicates on
// the contract input: end must be after start, and the window may not exceed 366
// days (bounding the ClickHouse scan). Drive both through the input schema.

const start = "2026-01-01T00:00:00.000Z";
const withinRangeEnd = "2026-02-01T00:00:00.000Z"; // ~31 days
const overRangeEnd = "2027-06-01T00:00:00.000Z"; // > 366 days after start

describe("preview_reseller_rebill contract", () => {
  it("is a read-only, ungated billing capability", () => {
    const cap = getCapability("preview_reseller_rebill");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("billing");
    expect(cap?.mode).toBe("sync");
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.agent?.requiresApproval).toBe(false);
  });

  describe("period-bound refinements", () => {
    it("accepts a valid in-range period, with customerId optional", () => {
      const parsed = resellerRebillPreview.input.parse({
        start,
        end: withinRangeEnd,
      });
      expect(parsed.start).toBe(start);
      expect(parsed.end).toBe(withinRangeEnd);
      expect(parsed.customerId).toBeUndefined();
    });

    it("accepts a single-customer preview", () => {
      const parsed = resellerRebillPreview.input.parse({
        start,
        end: withinRangeEnd,
        customerId: "rescus_abc",
      });
      expect(parsed.customerId).toBe("rescus_abc");
    });

    it("rejects an end that is not after start", () => {
      const res = resellerRebillPreview.input.safeParse({
        start,
        end: start, // equal → not strictly after
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.message === "end must be after start")).toBe(true);
        expect(res.error.issues.some((i) => i.path.includes("end"))).toBe(true);
      }
    });

    it("rejects an end that predates start", () => {
      expect(
        resellerRebillPreview.input.safeParse({
          start: withinRangeEnd,
          end: start,
        }).success,
      ).toBe(false);
    });

    it("rejects a period longer than 366 days", () => {
      const res = resellerRebillPreview.input.safeParse({
        start,
        end: overRangeEnd,
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(
          res.error.issues.some((i) => i.message === "period must not exceed 366 days"),
        ).toBe(true);
      }
    });

    it("rejects a non-ISO datetime before the refinements run", () => {
      expect(
        resellerRebillPreview.input.safeParse({ start: "not-a-date", end: withinRangeEnd })
          .success,
      ).toBe(false);
    });
  });
});
