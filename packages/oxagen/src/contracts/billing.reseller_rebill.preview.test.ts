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
  });
});
