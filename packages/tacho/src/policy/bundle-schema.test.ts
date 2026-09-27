import { describe, expect, it } from "vitest";
import { unsignedBundle } from "../host/test-support";
import { cedarBundleSchema, policyBundleSchema } from "../wire";
import { testCedarBundle } from "./test-schema";

const SIGNATURE = { key_id: "k1", alg: "ed25519", sig: "c2ln" } as const;

describe("cedarBundleSchema", () => {
  it("accepts the compiled policies, the schema, and the agents on this host", () => {
    const cedar = testCedarBundle({ "a.b": "forbid (principal, action, resource);" }, ["a.b"]);
    expect(cedarBundleSchema.parse(cedar)).toEqual(cedar);
  });

  it("carries a principal's role and budget when the signer knows them", () => {
    const cedar = testCedarBundle({});
    cedar.principals[0] = {
      ...cedar.principals[0]!,
      operator_role: "sre",
      budget_remaining_cents: 1200,
    };
    expect(cedarBundleSchema.parse(cedar).principals[0]).toMatchObject({
      operator_role: "sre",
      budget_remaining_cents: 1200,
    });
  });

  it("refuses a bundle with no agent, an unknown field, or an empty policy", () => {
    const cedar = testCedarBundle({});
    expect(cedarBundleSchema.safeParse({ ...cedar, principals: [] }).success).toBe(false);
    expect(cedarBundleSchema.safeParse({ ...cedar, templates: {} }).success).toBe(false);
    expect(
      cedarBundleSchema.safeParse({ ...cedar, policies: { "a.b": "" } }).success,
    ).toBe(false);
    expect(
      cedarBundleSchema.safeParse({
        ...cedar,
        principals: [{ ...cedar.principals[0], team: "x" }],
      }).success,
    ).toBe(false);
    expect(
      cedarBundleSchema.safeParse({
        ...cedar,
        principals: [{ ...cedar.principals[0], budget_remaining_cents: -1 }],
      }).success,
    ).toBe(false);
  });

  it("refuses more than 2048 policies", () => {
    const policies = Object.fromEntries(
      Array.from({ length: 2049 }, (_, i) => [`p${i}`, "forbid (principal, action, resource);"]),
    );
    const result = cedarBundleSchema.safeParse({ ...testCedarBundle({}), policies });
    expect(result.success).toBe(false);
  });
});

describe("policyBundleSchema", () => {
  it("accepts a bundle that carries Cedar policies", () => {
    const bundle = { ...unsignedBundle({ cedar: testCedarBundle({}) }), signature: SIGNATURE };
    expect(policyBundleSchema.parse(bundle).cedar?.principals).toHaveLength(3);
  });

  it("accepts a bundle without them", () => {
    const bundle = { ...unsignedBundle(), signature: SIGNATURE };
    expect(policyBundleSchema.parse(bundle).cedar).toBeUndefined();
  });
});
