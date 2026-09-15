import { describe, expect, it } from "vitest";
import { z } from "zod";
import { billingGauBucketPurchase } from "./billing.gau_bucket.purchase";

const VALID_INPUT = {
  quantityGau: 10_000,
  successPath: "/acme/billing?checkout=success",
  cancelPath: "/acme/billing?checkout=cancel",
};

const VALID_OUTPUT = {
  checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_001",
  quantityGau: 10_000,
  blockSizeGau: 5_000,
  blocks: 2,
};

/** Every key a zod object schema declares, at any depth. */
function keysOf(schema: z.ZodTypeAny, prefix = ""): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([k, v]) => [
      `${prefix}${k}`,
      ...keysOf(v as z.ZodTypeAny, `${prefix}${k}.`),
    ]);
  }
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    return keysOf(schema.unwrap() as z.ZodTypeAny, prefix);
  }
  return [];
}

describe("billing.gau_bucket.purchase capability", () => {
  it("is a governed, approval-gated write that is never refused for lack of GAUs: mutates, scoped, noBillingGate, sensitivity high, Owner/Billing, requiresApproval", () => {
    expect(billingGauBucketPurchase.name).toBe("purchase_gau_bucket");
    expect(billingGauBucketPurchase.mutates).toBe(true);
    expect(billingGauBucketPurchase.scoped).toBe(true);
    expect(billingGauBucketPurchase.noBillingGate).toBe(true);
    expect(billingGauBucketPurchase.sensitivity).toBe("high");
    expect(billingGauBucketPurchase.agent?.requiresApproval).toBe(true);
    expect(billingGauBucketPurchase.defaultEffect).toBe("deny");
    expect(billingGauBucketPurchase.defaultRoles?.org).toEqual({
      Owner: "allow",
      Billing: "allow",
    });
  });

  it("declares no app layer until WL-50 binds the page", () => {
    expect(billingGauBucketPurchase.layers).not.toContain("app");
  });

  it("carries no money field on either side: the total is the rate block's, and Stripe shows the figure", () => {
    const keys = [
      ...keysOf(billingGauBucketPurchase.input),
      ...keysOf(billingGauBucketPurchase.output),
    ];
    expect(keys).toEqual([
      "quantityGau",
      "successPath",
      "cancelPath",
      "checkoutUrl",
      "quantityGau",
      "blockSizeGau",
      "blocks",
    ]);
    for (const key of keys) {
      expect(key).not.toMatch(/usd|cents|micros|price|amount|total|money/i);
    }
  });

  it("parses a valid input", () => {
    expect(billingGauBucketPurchase.input.parse(VALID_INPUT)).toEqual(
      VALID_INPUT,
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -5_000],
    ["fractional", 2_500.5],
    ["above one million", 1_000_001],
    ["a string", "5000"],
  ])("rejects a quantity that is %s", (_name, quantityGau) => {
    expect(() =>
      billingGauBucketPurchase.input.parse({ ...VALID_INPUT, quantityGau }),
    ).toThrow();
  });

  it("accepts exactly one million units", () => {
    expect(
      billingGauBucketPurchase.input.parse({
        ...VALID_INPUT,
        quantityGau: 1_000_000,
      }).quantityGau,
    ).toBe(1_000_000);
  });

  it.each([
    ["an absolute URL", "https://evil.example/billing"],
    ["a protocol-relative URL", "//evil.example/billing"],
    ["a backslash after the slash", "/\\evil.example"],
    ["a relative path", "acme/billing"],
    ["an empty string", ""],
    ["a path with whitespace", "/acme/billing ?x=1"],
    ["a path with a control character", "/acme/billing\u0000"],
    ["a scheme with no slash", "javascript:alert(1)"],
  ])("rejects %s as a return path", (_name, path) => {
    expect(() =>
      billingGauBucketPurchase.input.parse({
        ...VALID_INPUT,
        successPath: path,
      }),
    ).toThrow();
    expect(() =>
      billingGauBucketPurchase.input.parse({
        ...VALID_INPUT,
        cancelPath: path,
      }),
    ).toThrow();
  });

  it("accepts the root path and a path with a query", () => {
    expect(
      billingGauBucketPurchase.input.parse({
        ...VALID_INPUT,
        successPath: "/",
        cancelPath: "/acme/billing?checkout=cancel&x=1#top",
      }),
    ).toMatchObject({
      successPath: "/",
      cancelPath: "/acme/billing?checkout=cancel&x=1#top",
    });
  });

  it("parses the output", () => {
    expect(billingGauBucketPurchase.output.parse(VALID_OUTPUT)).toEqual(
      VALID_OUTPUT,
    );
  });

  it("rejects a checkout URL that is not a URL", () => {
    expect(() =>
      billingGauBucketPurchase.output.parse({
        ...VALID_OUTPUT,
        checkoutUrl: "cs_test_001",
      }),
    ).toThrow();
  });

  it.each(["quantityGau", "blockSizeGau", "blocks"] as const)(
    "rejects a zero or fractional %s on the output",
    (field) => {
      expect(() =>
        billingGauBucketPurchase.output.parse({ ...VALID_OUTPUT, [field]: 0 }),
      ).toThrow();
      expect(() =>
        billingGauBucketPurchase.output.parse({
          ...VALID_OUTPUT,
          [field]: 1.5,
        }),
      ).toThrow();
    },
  );
});
