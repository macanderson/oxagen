import { describe, expect, it } from "vitest";
import { buildPrunedProperties, parseNodeProps } from "./schema.reconcile";

describe("buildPrunedProperties (schema.reconcile pure helper)", () => {
  it("keeps all properties that are present in the schema", () => {
    const existing = { name: "Acme Corp", industry: "SaaS", founded: 2015 };
    const schemaKeys = ["name", "industry", "founded"];

    const { pruned, removedKeys } = buildPrunedProperties(existing, schemaKeys);

    expect(pruned).toEqual({
      name: "Acme Corp",
      industry: "SaaS",
      founded: 2015,
    });
    expect(removedKeys).toHaveLength(0);
  });

  it("removes off-schema properties when schema is a subset of existing keys", () => {
    const existing = {
      name: "Acme Corp",
      extraProp: "should be removed",
      anotherExtra: 42,
    };
    const schemaKeys = ["name"];

    const { pruned, removedKeys } = buildPrunedProperties(existing, schemaKeys);

    expect(pruned).toEqual({ name: "Acme Corp" });
    expect(removedKeys).toContain("extraProp");
    expect(removedKeys).toContain("anotherExtra");
    expect(removedKeys).toHaveLength(2);
  });

  it("downgrade prunes properties a forward heal added that are not in the older schema", () => {
    // Simulate: node has existing props including one that was AI-derived during a
    // prior forward-heal to a newer schema version. Pinning an older version
    // and calling buildPrunedProperties with prune=true should remove it.
    const existingAfterForwardHeal = {
      name: "foo",
      extraProp: "added by forward heal — not in older schema",
    };
    // The older schema only defines 'name'.
    const olderSchemaKeys = ["name"];

    const { pruned, removedKeys } = buildPrunedProperties(
      existingAfterForwardHeal,
      olderSchemaKeys,
    );

    expect(pruned).toEqual({ name: "foo" });
    expect(removedKeys).toEqual(["extraProp"]);
  });

  it("additive-only default: when schema includes all existing keys, no props are removed", () => {
    // prune=false is enforced at the caller level; buildPrunedProperties itself
    // is always called with schemaKeys that include the existing keys (no pruning).
    const existing = { name: "Bar", size: "large" };
    const schemaKeys = ["name", "size", "description"]; // schema is a superset

    const { pruned, removedKeys } = buildPrunedProperties(existing, schemaKeys);

    // Existing props are kept as-is; no additions (caller handles AI derivation).
    expect(pruned).toEqual({ name: "Bar", size: "large" });
    expect(removedKeys).toHaveLength(0);
  });

  it("handles an empty existing properties object", () => {
    const { pruned, removedKeys } = buildPrunedProperties({}, ["name", "age"]);

    expect(pruned).toEqual({});
    expect(removedKeys).toHaveLength(0);
  });

  it("handles an empty schema keys array (prunes everything)", () => {
    const existing = { name: "Test", value: 42 };
    const { pruned, removedKeys } = buildPrunedProperties(existing, []);

    expect(pruned).toEqual({});
    expect(removedKeys).toContain("name");
    expect(removedKeys).toContain("value");
    expect(removedKeys).toHaveLength(2);
  });

  it("preserves null and undefined values for schema-defined keys", () => {
    const existing = { name: null, description: undefined, count: 0 };
    const schemaKeys = ["name", "description", "count"];

    const { pruned, removedKeys } = buildPrunedProperties(existing, schemaKeys);

    expect(pruned).toEqual({ name: null, description: undefined, count: 0 });
    expect(removedKeys).toHaveLength(0);
  });
});

describe("parseNodeProps (schema.reconcile — canonical JSON-string property bag)", () => {
  it("parses the JSON string that graph.node.upsert stores in n.properties", () => {
    // This is the real shape: n.properties is JSON.stringify(bag), not a map.
    const raw = JSON.stringify({
      summary: "a customer",
      number_of_licenses: 5,
    });
    expect(parseNodeProps(raw)).toEqual({
      summary: "a customer",
      number_of_licenses: 5,
    });
  });

  it("returns {} for null/undefined (node never had properties)", () => {
    expect(parseNodeProps(null)).toEqual({});
    expect(parseNodeProps(undefined)).toEqual({});
  });

  it("returns {} for malformed JSON or non-object JSON (never throws)", () => {
    expect(parseNodeProps("{not valid json")).toEqual({});
    expect(parseNodeProps('"a string"')).toEqual({});
    expect(parseNodeProps("[1,2,3]")).toEqual({});
    expect(parseNodeProps("42")).toEqual({});
  });

  it("tolerates a legacy raw object value", () => {
    expect(parseNodeProps({ a: 1 })).toEqual({ a: 1 });
    expect(parseNodeProps([1, 2])).toEqual({});
  });

  it("round-trips with JSON.stringify (the write path) so heal/prune persist", () => {
    // Read existing → merge derived → write back as a JSON string → read again.
    const existing = parseNodeProps(JSON.stringify({ name: "foo" }));
    const healed = { ...existing, summary: "derived" };
    const written = JSON.stringify(healed); // mirrors the SET n.properties = $properties write
    expect(parseNodeProps(written)).toEqual({
      name: "foo",
      summary: "derived",
    });
  });
});
