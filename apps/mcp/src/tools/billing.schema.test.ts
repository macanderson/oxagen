// billing.schema.test.ts — unit tests for billing tool input schemas.
//
// Covers: billing.credits.purchase.
// Pure schema logic; no network / DB / xmcp runtime involved.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { obj } from "./_schema-test-helpers";

// ── billing.credits.purchase ─────────────────────────────────────────────────

import { schema as billingCreditsPurchaseSchema } from "./billing.credits.purchase";

describe("billing.credits.purchase schema", () => {
  const Schema = obj(billingCreditsPurchaseSchema);

  it("accepts the minimum valid purchase amount ($5 exactly)", () => {
    expect(() => Schema.parse({ amountUsd: 5 })).not.toThrow();
  });

  it("accepts a typical purchase amount ($50)", () => {
    expect(() => Schema.parse({ amountUsd: 50 })).not.toThrow();
  });

  it("accepts a large purchase amount ($500)", () => {
    expect(() => Schema.parse({ amountUsd: 500 })).not.toThrow();
  });

  it("rejects $4.99 (below $5 minimum)", () => {
    expect(() => Schema.parse({ amountUsd: 4.99 })).toThrow();
  });

  it("rejects $0 (zero is below minimum)", () => {
    expect(() => Schema.parse({ amountUsd: 0 })).toThrow();
  });

  it("rejects a negative amount", () => {
    expect(() => Schema.parse({ amountUsd: -10 })).toThrow();
  });

  it("rejects -5 (negative, despite matching the $5 boundary)", () => {
    expect(() => Schema.parse({ amountUsd: -5 })).toThrow();
  });

  it("rejects missing amountUsd", () => {
    expect(() => Schema.parse({})).toThrow();
  });

  it("rejects a string amount (wrong type)", () => {
    expect(() => Schema.parse({ amountUsd: "50" })).toThrow();
  });

  it("includes 'Minimum purchase is $5' in the error message for $4.99", () => {
    let errorMessage = "";
    try {
      Schema.parse({ amountUsd: 4.99 });
    } catch (err) {
      if (err instanceof z.ZodError) {
        errorMessage = err.issues.map((i) => i.message).join(" ");
      }
    }
    expect(errorMessage).toContain("Minimum purchase is $5");
  });

  it("includes 'Minimum purchase is $5' in the error message for $1", () => {
    let errorMessage = "";
    try {
      Schema.parse({ amountUsd: 1 });
    } catch (err) {
      if (err instanceof z.ZodError) {
        errorMessage = err.issues.map((i) => i.message).join(" ");
      }
    }
    expect(errorMessage).toContain("Minimum purchase is $5");
  });

  it("rejects NaN", () => {
    expect(() => Schema.parse({ amountUsd: NaN })).toThrow();
  });

  it("accepts Infinity (Zod z.number() does not reject Infinity; the handler enforces a practical cap)", () => {
    // z.number().positive().min(5) does NOT reject Infinity — Infinity > 5 and > 0.
    // A real-world upper cap belongs in the handler or Stripe validation, not this schema.
    expect(() => Schema.parse({ amountUsd: Infinity })).not.toThrow();
  });
});

// ── billing.usage.breakdown ──────────────────────────────────────────────────

import { schema as billingUsageBreakdownSchema } from "./billing.usage.breakdown";

describe("billing.usage.breakdown schema", () => {
  const Schema = obj(billingUsageBreakdownSchema);
  const valid = {
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-07-01T00:00:00.000Z",
  };

  it("accepts a valid ISO window without a workspace filter", () => {
    expect(() => Schema.parse(valid)).not.toThrow();
  });

  it("accepts an optional workspace UUID", () => {
    expect(() =>
      Schema.parse({
        ...valid,
        workspaceId: "22222222-2222-2222-2222-222222222222",
      }),
    ).not.toThrow();
  });

  it("rejects a non-ISO start", () => {
    expect(() => Schema.parse({ ...valid, start: "2026-06-01" })).toThrow();
  });

  it("rejects a non-UUID workspaceId", () => {
    expect(() =>
      Schema.parse({ ...valid, workspaceId: "not-a-uuid" }),
    ).toThrow();
  });

  it("rejects a missing end bound", () => {
    expect(() => Schema.parse({ start: valid.start })).toThrow();
  });
});
