import { describe, expect, it } from "vitest";
import {
  buildPrunedProperties,
  buildRelationshipWriteBack,
  parseNodeProps,
  RESERVED_RELATIONSHIP_PROPERTY_KEYS,
} from "./schema.reconcile";

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

// ── Relationship prune write-back ────────────────────────────────────────────
//
// These assert the END STATE OF THE PROPERTY BAG, never that the job reported
// success. Asserting the counter is what hid the defect: `prunedRelationships`
// incremented on every pruned relationship while `SET r += $props` removed
// nothing, so the metric looked healthy for work that never happened.
//
// The applier below implements Neo4j's semantics exactly — `+=` MERGES (a key
// absent from the map survives) and `REMOVE` deletes the named keys. It is
// deliberately not more permissive than the database in the one direction that
// matters: if it implemented `+=` as a replacement it would report these tests
// green against the broken code.

/** Apply `SET r += $props [REMOVE r.`k`, …]` to a property bag, as Neo4j would. */
function applyWriteBack(
  stored: Record<string, unknown>,
  props: Record<string, unknown>,
  removeClause: string,
): Record<string, unknown> {
  const next = { ...stored, ...props }; // `+=` merges; it never deletes.
  // Parse `r.`key`` the way Cypher reads a quoted identifier: a doubled
  // backtick is one literal backtick, a single one ends the name. Modelling
  // this rather than a naive [^`]+ is what makes the escaping test meaningful.
  for (const m of removeClause.matchAll(/r\.`((?:[^`]|``)*)`/g)) {
    delete next[m[1]!.replace(/``/g, "`")];
  }
  return next;
}

describe("relationship prune write-back", () => {
  // A relationship as it exists in the graph: platform-owned temporal and
  // tenancy properties, one schema property, one property the schema dropped.
  const stored = (): Record<string, unknown> => ({
    orgId: "org-1",
    workspaceId: "ws-1",
    is_system: false,
    validFrom: "2026-01-01T00:00:00Z",
    validTo: null,
    recordedAt: "2026-01-02T00:00:00Z",
    invalidatedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    confidence: 0.9, // in schema
    legacyNote: "written by an older schema version", // NOT in schema
  });
  const schemaKeys = ["confidence"];

  it("removes the off-schema property from the relationship", () => {
    const before = stored();
    const { pruned, removedKeys } = buildPrunedProperties(
      before,
      schemaKeys,
      RESERVED_RELATIONSHIP_PROPERTY_KEYS,
    );
    const { removeClause } = buildRelationshipWriteBack(removedKeys);
    const after = applyWriteBack(before, pruned, removeClause);

    expect(removedKeys).toEqual(["legacyNote"]);
    expect(after).not.toHaveProperty("legacyNote");
  });

  it("would NOT have removed it with a merge-only write (the defect)", () => {
    const before = stored();
    const { pruned } = buildPrunedProperties(
      before,
      schemaKeys,
      RESERVED_RELATIONSHIP_PROPERTY_KEYS,
    );
    // The previous write: `SET r += $props`, no REMOVE.
    const after = applyWriteBack(before, pruned, "");
    expect(after.legacyNote).toBe("written by an older schema version");
  });

  it("preserves every platform-owned property through the prune", () => {
    const before = stored();
    const { pruned, removedKeys } = buildPrunedProperties(
      before,
      schemaKeys,
      RESERVED_RELATIONSHIP_PROPERTY_KEYS,
    );
    const { removeClause } = buildRelationshipWriteBack(removedKeys);
    const after = applyWriteBack(before, pruned, removeClause);

    for (const key of RESERVED_RELATIONSHIP_PROPERTY_KEYS) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.confidence).toBe(0.9);
  });

  it("would have destroyed the temporal ledger without the reserved set", () => {
    // The same prune computed from schema keys alone, which is what the code
    // did before this change. Every platform property lands in removedKeys.
    const before = stored();
    const { pruned, removedKeys } = buildPrunedProperties(before, schemaKeys);
    const { removeClause } = buildRelationshipWriteBack(removedKeys);
    const after = applyWriteBack(before, pruned, removeClause);

    expect(removedKeys).toContain("validFrom");
    expect(removedKeys).toContain("orgId");
    expect(after).not.toHaveProperty("recordedAt");
  });

  it("emits no REMOVE when nothing was pruned", () => {
    expect(buildRelationshipWriteBack([]).removeClause).toBe("");
    expect(buildRelationshipWriteBack([]).setClause).toBe("SET r += $props");
  });

  // `schema.property.upsert` accepts any non-empty string up to 200 characters,
  // so these are ORDINARY valid property names, not hostile input. An earlier
  // version of this builder restricted keys to JavaScript-identifier syntax and
  // threw on them — failing the reconcile step on exactly the legacy keys the
  // prune exists to clean up.
  it("prunes legal property names that need escaping", () => {
    const keys = [
      "legacy-note",
      "display name",
      "with`backtick",
      "a".repeat(200),
    ];
    const stored: Record<string, unknown> = { confidence: 0.9 };
    for (const k of keys) stored[k] = "x";

    const { pruned, removedKeys } = buildPrunedProperties(
      stored,
      ["confidence"],
      RESERVED_RELATIONSHIP_PROPERTY_KEYS,
    );
    const { removeClause } = buildRelationshipWriteBack(removedKeys);
    const after = applyWriteBack(stored, pruned, removeClause);

    for (const k of keys) expect(after).not.toHaveProperty(k);
    expect(after.confidence).toBe(0.9);
  });

  it("escapes an embedded backtick by doubling, so a key cannot close the quote", () => {
    // Without doubling, a key of "a`) DETACH DELETE r //" would end the quoted
    // identifier and append a clause.
    const { removeClause } = buildRelationshipWriteBack([
      "a`) DETACH DELETE r //",
    ]);
    expect(removeClause).toBe(" REMOVE r.`a``) DETACH DELETE r //`");
    // Exactly one quoted identifier: every backtick inside it is doubled.
    expect(removeClause.match(/`/g)?.length).toBe(4);
  });

  it("quotes a 200-character key without truncating it", () => {
    const key = "k".repeat(200);
    expect(buildRelationshipWriteBack([key]).removeClause).toBe(
      ` REMOVE r.\`${key}\``,
    );
  });

  it("throws rather than silently skipping an unexpressable key", () => {
    // Skipping would restore the original defect: a prune that reports success
    // and removes nothing.
    expect(() => buildRelationshipWriteBack([""])).toThrow(/empty/);
  });
});
