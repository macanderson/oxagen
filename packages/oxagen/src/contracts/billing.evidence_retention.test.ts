/**
 * Contract tests for `get_evidence_retention` (ADR-052 §4.3).
 *
 * The field that matters most here is `storedGbBeyondIncluded`, which is
 * NULLABLE on purpose: "we have not measured your evidence volume" and "you
 * are storing nothing" are different claims, and only one of them is true
 * before the accounting job has run. A schema that forced a number would make
 * the handler assert the false one.
 */
import { describe, expect, it } from "vitest";
import { billingEvidenceRetention } from "./billing.evidence_retention";

const unmeasured = {
  includedMonths: 12,
  effectiveRetentionDays: 365,
  extendedRetentionEnabled: false,
  usdPerGbMonth: 0.08,
  storedGbBeyondIncluded: null,
  storedGbMeasured: false,
  creditsChargedThisPeriod: 0,
};

describe("billing.evidence_retention contract", () => {
  it("is registered under its ADR-025 verb-first name", () => {
    expect(billingEvidenceRetention.name).toBe("get_evidence_retention");
  });

  it("never bills the caller for reading its own retention posture", () => {
    expect(billingEvidenceRetention.noBillingGate).toBe(true);
  });

  it("parses an empty input and rejects a non-object", () => {
    expect(billingEvidenceRetention.input.parse({})).toEqual({});
    expect(() => billingEvidenceRetention.input.parse(7)).toThrow();
  });

  it("accepts an unmeasured volume as null rather than forcing a false zero", () => {
    const parsed = billingEvidenceRetention.output.parse(unmeasured);
    expect(parsed.storedGbBeyondIncluded).toBeNull();
    expect(parsed.storedGbMeasured).toBe(false);
  });

  it("accepts a measured zero, which is a different claim from an unmeasured null", () => {
    const parsed = billingEvidenceRetention.output.parse({
      ...unmeasured,
      storedGbBeyondIncluded: 0,
      storedGbMeasured: true,
    });
    expect(parsed.storedGbBeyondIncluded).toBe(0);
    expect(parsed.storedGbMeasured).toBe(true);
  });

  it("accepts a null retention window — no policy pinned is not the same as keeping nothing", () => {
    const parsed = billingEvidenceRetention.output.parse({
      ...unmeasured,
      effectiveRetentionDays: null,
    });
    expect(parsed.effectiveRetentionDays).toBeNull();
  });

  it("refuses a zero-day retention window, which would read as a policy rather than an absence", () => {
    expect(() =>
      billingEvidenceRetention.output.parse({
        ...unmeasured,
        effectiveRetentionDays: 0,
      }),
    ).toThrow();
  });

  it("refuses a negative stored volume or a negative charge", () => {
    expect(() =>
      billingEvidenceRetention.output.parse({
        ...unmeasured,
        storedGbBeyondIncluded: -1,
        storedGbMeasured: true,
      }),
    ).toThrow();
    expect(() =>
      billingEvidenceRetention.output.parse({
        ...unmeasured,
        creditsChargedThisPeriod: -1,
      }),
    ).toThrow();
  });
});
