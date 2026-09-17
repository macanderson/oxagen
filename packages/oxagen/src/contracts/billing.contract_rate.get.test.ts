import { describe, expect, it } from "vitest";
import { billingContractRateGet } from "./billing.contract_rate.get";

const VALID = {
  source: "published_tier" as const,
  agreementRef: null,
  tier: "scale" as const,
  currency: "usd",
  ratePerGauMicros: "5000",
  blockSizeGau: 5000,
  includedGauPerMonth: 300_000,
  effectiveFrom: "2026-09-14T00:00:00.000Z",
  effectiveTo: null,
};

describe("billing.contract_rate.get capability", () => {
  it("is a read that is never refused for lack of GAUs: mutates false, scoped, noBillingGate, Owner/Admin/Billing", () => {
    expect(billingContractRateGet.mutates).toBe(false);
    expect(billingContractRateGet.scoped).toBe(true);
    expect(billingContractRateGet.noBillingGate).toBe(true);
    expect(billingContractRateGet.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
    });
  });

  it("parses an empty input object", () => {
    expect(billingContractRateGet.input.parse({})).toEqual({});
  });

  it("rejects a non-object input", () => {
    expect(() => billingContractRateGet.input.parse("nope")).toThrow();
  });

  it("parses the published-tier output", () => {
    const parsed = billingContractRateGet.output.parse(VALID);
    expect(parsed.source).toBe("published_tier");
    expect(parsed.agreementRef).toBeNull();
    expect(parsed.effectiveTo).toBeNull();
  });

  it("parses a negotiated output with an agreement reference and an end date", () => {
    const parsed = billingContractRateGet.output.parse({
      ...VALID,
      source: "negotiated",
      agreementRef: "MSA-2026-017",
      ratePerGauMicros: "7500",
      effectiveTo: "2027-06-01T00:00:00.000Z",
    });
    expect(parsed.agreementRef).toBe("MSA-2026-017");
    expect(parsed.effectiveTo).toBe("2027-06-01T00:00:00.000Z");
  });

  it("carries a rate wider than a safe integer without losing a digit", () => {
    const parsed = billingContractRateGet.output.parse({
      ...VALID,
      ratePerGauMicros: "90071992547409910",
    });
    expect(parsed.ratePerGauMicros).toBe("90071992547409910");
  });

  it("rejects a rate that is a number, so no money crosses the wire as a float", () => {
    expect(() =>
      billingContractRateGet.output.parse({ ...VALID, ratePerGauMicros: 5000 }),
    ).toThrow();
  });

  it("rejects a fractional rate string", () => {
    expect(() =>
      billingContractRateGet.output.parse({
        ...VALID,
        ratePerGauMicros: "5000.5",
      }),
    ).toThrow();
  });

  it("rejects a negative rate string", () => {
    expect(() =>
      billingContractRateGet.output.parse({
        ...VALID,
        ratePerGauMicros: "-5000",
      }),
    ).toThrow();
  });

  it("rejects a source outside the two the resolver can answer with", () => {
    expect(() =>
      billingContractRateGet.output.parse({ ...VALID, source: "rate_band" }),
    ).toThrow();
  });

  it("rejects a tier outside the four the plans table allows", () => {
    expect(() =>
      billingContractRateGet.output.parse({ ...VALID, tier: "startup" }),
    ).toThrow();
  });

  it("rejects a currency that is not a three-letter code", () => {
    expect(() =>
      billingContractRateGet.output.parse({ ...VALID, currency: "dollars" }),
    ).toThrow();
  });

  it("rejects a zero block size: a block prices nothing", () => {
    expect(() =>
      billingContractRateGet.output.parse({ ...VALID, blockSizeGau: 0 }),
    ).toThrow();
  });

  it("rejects a fractional block size", () => {
    expect(() =>
      billingContractRateGet.output.parse({ ...VALID, blockSizeGau: 2500.5 }),
    ).toThrow();
  });

  it("accepts a zero monthly allowance and rejects a negative one", () => {
    expect(
      billingContractRateGet.output.parse({
        ...VALID,
        includedGauPerMonth: 0,
      }).includedGauPerMonth,
    ).toBe(0);
    expect(() =>
      billingContractRateGet.output.parse({
        ...VALID,
        includedGauPerMonth: -1,
      }),
    ).toThrow();
  });

  it("rejects an effective date that is not an ISO 8601 instant", () => {
    expect(() =>
      billingContractRateGet.output.parse({
        ...VALID,
        effectiveFrom: "2026-09-14",
      }),
    ).toThrow();
  });

  it("rejects a missing effectiveFrom: every rate answers from when", () => {
    const { effectiveFrom: _omitted, ...withoutFrom } = VALID;
    expect(() => billingContractRateGet.output.parse(withoutFrom)).toThrow();
  });
});
