import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPrunedProperties,
  buildRelationshipWriteBackProps,
  NON_SYSTEM_RELATIONSHIP_FILTER,
  parseNodeProps,
  PLATFORM_REL_TYPE_PARAMS,
  PLATFORM_REL_TYPES_PARAM,
  PLATFORM_RELATIONSHIP_TYPES,
  RELATIONSHIP_WRITE_BACK_CYPHER,
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

/**
 * Apply `SET r += $props` to a property bag, as Neo4j does: `+=` MERGES, so a
 * key absent from the map survives, and "if any property in the map is `null`,
 * it will be removed" (Cypher manual, SET). Modelling both halves is what makes
 * these tests meaningful — an applier that treated `+=` as a replacement would
 * report green against a builder that removed nothing, and one that ignored
 * nulls would report green against the merge-only write that was the defect.
 */
function applyWriteBack(
  stored: Record<string, unknown>,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...stored };
  for (const [key, value] of Object.entries(props)) {
    if (value === null) delete next[key];
    else next[key] = value;
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

  /** The prune exactly as the job runs it. */
  function prune(
    before: Record<string, unknown>,
    keys: string[] = schemaKeys,
    reserved = RESERVED_RELATIONSHIP_PROPERTY_KEYS,
  ) {
    const { pruned, removedKeys } = buildPrunedProperties(
      before,
      keys,
      reserved,
    );
    return {
      removedKeys,
      after: applyWriteBack(
        before,
        buildRelationshipWriteBackProps(pruned, removedKeys),
      ),
    };
  }

  it("removes the off-schema property from the relationship", () => {
    const before = stored();
    const { removedKeys, after } = prune(before);
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
    // The previous write: `SET r += $props` with the key merely OMITTED.
    const after = applyWriteBack(before, pruned);
    expect(after.legacyNote).toBe("written by an older schema version");
  });

  it("preserves every reserved property through the prune", () => {
    const before = stored();
    const { after } = prune(before);
    for (const key of RESERVED_RELATIONSHIP_PROPERTY_KEYS) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.confidence).toBe(0.9);
  });

  it("would have destroyed the temporal ledger without the reserved set", () => {
    // The same prune computed from schema keys alone, which is what the code
    // did before this change. Every platform property lands in removedKeys.
    const before = stored();
    const { removedKeys, after } = prune(before, schemaKeys, new Set<string>());
    expect(removedKeys).toContain("validFrom");
    expect(removedKeys).toContain("orgId");
    expect(after).not.toHaveProperty("recordedAt");
  });

  it("carries no null when nothing was pruned", () => {
    const props = buildRelationshipWriteBackProps({ confidence: 0.9 }, []);
    expect(props).toEqual({ confidence: 0.9 });
    expect(Object.values(props)).not.toContain(null);
  });

  it("a retained null is omitted, not turned into a removal", () => {
    // `null` is this map's removal instruction, so a retained key may never
    // carry one. Omitting it is also what "retain" means under `+=`: a key the
    // map does not mention is left exactly as it is. Without this, an
    // AI-derived property the model returned as null would delete whatever the
    // relationship already had under that name.
    const props = buildRelationshipWriteBackProps(
      { confidence: 0.9, validTo: null, note: undefined },
      ["legacyNote"],
    );
    expect(props).toEqual({ confidence: 0.9, legacyNote: null });
    expect(
      applyWriteBack({ validTo: "2026-06-01T00:00:00Z" }, props).validTo,
    ).toBe("2026-06-01T00:00:00Z");
  });

  // `schema.property.upsert` accepts any non-empty string up to 200 characters,
  // so these are ORDINARY valid property names, not hostile input. An earlier
  // version of this builder restricted keys to JavaScript-identifier syntax and
  // threw on them — failing the reconcile step on exactly the legacy keys the
  // prune exists to clean up.
  it("prunes legal property names that no identifier syntax would admit", () => {
    const keys = [
      "legacy-note",
      "display name",
      "with`backtick",
      "a".repeat(200),
    ];
    const before: Record<string, unknown> = { confidence: 0.9 };
    for (const k of keys) before[k] = "x";

    const { after } = prune(before, ["confidence"]);
    for (const k of keys) expect(after).not.toHaveProperty(k);
    expect(after.confidence).toBe(0.9);
  });

  it("throws rather than silently skipping an unexpressable key", () => {
    // Skipping would restore the original defect: a prune that reports success
    // and removes nothing.
    expect(() => buildRelationshipWriteBackProps({}, [""])).toThrow(/empty/);
  });
});

// ── The escape that defeats quoting ──────────────────────────────────────────
//
// Cypher decodes `\uXXXX` escapes INSIDE a backtick-quoted name, and it does so
// at PARSE time — after any doubling a builder applied to the string. So a
// builder that escapes and a parser that decodes disagree about what a backtick
// is, and the parser is the one that runs the query. `schema.property.upsert`
// accepts any non-empty string up to 200 characters, so a key carrying the six
// ASCII characters `\u0060` is a LEGAL property name that reconciliation can
// write through the parameterized property map and a later prune reads back.
//
// The fix is not a better escape. It is that a property name never becomes
// query text: removal is a `null` in the parameter map, and the Cypher is a
// constant. These tests assert that property against the generated Cypher —
// there is no Neo4j in this package's test rig, so the parser step is modelled
// rather than executed.

/** The one parser step string-level escaping cannot see. */
function asNeo4jWouldParse(cypher: string): string {
  return cypher.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

describe("relationship prune write-back — a property key is never query text", () => {
  const HOSTILE = "a\\u0060 WITH r MATCH (v) DETACH DELETE v //";

  it("keeps the hostile key out of the query entirely", () => {
    const props = buildRelationshipWriteBackProps({ confidence: 0.9 }, [
      HOSTILE,
    ]);
    // The query is fixed text. Nothing about the key reaches it, so there is
    // no encoding of a delimiter left for a parser to decode.
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).not.toContain("DETACH DELETE");
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).not.toContain("REMOVE");
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).not.toContain("`");
    // …and the key is still NAMED, so the removal is stated, not implied.
    expect(props[HOSTILE]).toBeNull();
  });

  it("leaves no executable residue once the parser decodes the query", () => {
    // The assertion that was red before the fix: with the key interpolated
    // into `REMOVE r.\`key\``, decoding `\u0060` terminated the identifier and
    // left ` WITH r MATCH (v) DETACH DELETE v //` as Cypher.
    buildRelationshipWriteBackProps({}, [HOSTILE]);
    const parsed = asNeo4jWouldParse(RELATIONSHIP_WRITE_BACK_CYPHER);
    expect(parsed).toBe(RELATIONSHIP_WRITE_BACK_CYPHER);
    expect(parsed).not.toMatch(/\bDETACH\s+DELETE\b/);
  });

  it("the write itself cannot land on a platform-owned edge", () => {
    // Defence in depth for the prune exclusion: even if the batch read were
    // ever loosened, the destructive write is still filtered.
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain(
      NON_SYSTEM_RELATIONSHIP_FILTER,
    );
  });
});

// ── Platform-owned edges are not user data ───────────────────────────────────
describe("schema reconciliation excludes platform-owned relationships", () => {
  it("filters the edge and both of its endpoints", () => {
    // The edge flag is the direct marker; the endpoint flags are the backstop
    // for a writer that forgets it. Absent is not false — hence coalesce.
    expect(NON_SYSTEM_RELATIONSHIP_FILTER).toContain(
      "coalesce(r.is_system, false) = false",
    );
    expect(NON_SYSTEM_RELATIONSHIP_FILTER).toContain(
      "coalesce(a.is_system, false) = false",
    );
    expect(NON_SYSTEM_RELATIONSHIP_FILTER).toContain(
      "coalesce(b.is_system, false) = false",
    );
  });

  it("an ALIAS_OF edge named by a pinned schema keeps its dedup metadata", () => {
    // The defect this closes: a pinned schema naming the platform type
    // ALIAS_OF with only `confidence` declared. Reconciliation used to reach
    // the edge (EntityNode carries the :GraphNode anchor label) and the newly
    // effective removal would have deleted `matchReason` and `tentative` —
    // neither of which any reserved-key list contained, because the set of
    // platform-owned relationship properties is open.
    const aliasEdge: Record<string, unknown> = {
      confidence: 0.94,
      matchReason: "embedding:0.94",
      tentative: false,
      is_system: true,
      createdAt: "2026-01-01T00:00:00Z",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: null,
      recordedAt: "2026-01-01T00:00:00Z",
      invalidatedAt: null,
    };

    // What the prune WOULD do if the edge reached it.
    const { removedKeys } = buildPrunedProperties(
      aliasEdge,
      ["confidence"],
      RESERVED_RELATIONSHIP_PROPERTY_KEYS,
    );
    expect(removedKeys).toEqual(["matchReason", "tentative"]);

    // Which is exactly why it must not reach it. `is_system` is set on every
    // ALIAS_OF this repo writes — upsert-entity.ts on creation, and
    // ingestion.delete.ts when alias promotion reroutes one.
    expect(aliasEdge.is_system).toBe(true);
    expect(NON_SYSTEM_RELATIONSHIP_FILTER).toContain(
      "coalesce(r.is_system, false) = false",
    );
  });
});

// ── Unmarked platform edges already in the graph ─────────────────────────────

interface CandidateRow {
  type: string;
  r: Record<string, unknown>;
  a: Record<string, unknown>;
  b: Record<string, unknown>;
}

/**
 * Evaluate the SHIPPED filter text against one candidate row, the way Neo4j
 * would. Asserting on the string ("does it contain this clause") tests the
 * spelling; this tests the decision, which is what a customer's `matchReason`
 * depends on.
 *
 * An unrecognised conjunct THROWS rather than being skipped: a future edit that
 * adds a clause this evaluator cannot read fails loudly instead of silently
 * making every assertion below vacuous.
 */
function filterAccepts(row: CandidateRow): boolean {
  const params: Record<string, readonly string[]> = {
    [PLATFORM_REL_TYPES_PARAM]: PLATFORM_RELATIONSHIP_TYPES,
  };
  const endpoints: Record<string, Record<string, unknown>> = {
    r: row.r,
    a: row.a,
    b: row.b,
  };
  return NON_SYSTEM_RELATIONSHIP_FILTER.split(/\bAND\b/)
    .map((c) => c.trim().replace(/\s+/g, " "))
    .every((conjunct) => {
      const typeExclusion = /^NOT type\(r\) IN \$(\w+)$/.exec(conjunct);
      if (typeExclusion) {
        return !(params[typeExclusion[1]!] ?? []).includes(row.type);
      }
      const flag = /^coalesce\((r|a|b)\.is_system, false\) = false$/.exec(
        conjunct,
      );
      if (flag) return (endpoints[flag[1]!]!.is_system ?? false) === false;
      throw new Error(
        `filterAccepts cannot evaluate the conjunct "${conjunct}" — teach it ` +
          `the new clause rather than letting these assertions go vacuous.`,
      );
    });
}

describe("schema reconciliation excludes platform edges written before the marker", () => {
  /**
   * What `ingestion.delete`'s alias-promotion reroute wrote before this change:
   * the MERGE copied confidence / matchReason / tentative / createdAt and
   * nothing else, so the new edge carries no `is_system`. Both endpoints are
   * ingested `EntityNode`s, which carry `is_system = false`.
   */
  const preMarkerReroutedAlias: CandidateRow = {
    type: "ALIAS_OF",
    r: {
      confidence: 0.94,
      matchReason: "embedding:0.94",
      tentative: false,
      createdAt: "2026-01-01T00:00:00Z",
    },
    a: { is_system: false },
    b: { is_system: false },
  };

  it("skips an ALIAS_OF edge that carries no is_system marker", () => {
    // Every flag predicate reads false-or-absent here, so the marker-based
    // halves of the filter accept this edge. Only the type excludes it.
    expect(preMarkerReroutedAlias.r.is_system).toBeUndefined();
    expect(filterAccepts(preMarkerReroutedAlias)).toBe(false);
  });

  it("is what stops prune=true deleting the dedup ledger's operational fields", () => {
    // The damage the exclusion prevents, stated rather than implied: with an
    // `ALIAS_OF` schema pinned that declares only `confidence`, these are the
    // keys the null-valued write-back would remove — permanently.
    const { removedKeys } = buildPrunedProperties(
      preMarkerReroutedAlias.r,
      ["confidence"],
      RESERVED_RELATIONSHIP_PROPERTY_KEYS,
    );
    expect(removedKeys).toEqual(["matchReason", "tentative"]);
    expect(filterAccepts(preMarkerReroutedAlias)).toBe(false);
  });

  for (const type of PLATFORM_RELATIONSHIP_TYPES) {
    it(`skips an unmarked ${type} edge between two customer nodes`, () => {
      expect(
        filterAccepts({ type, r: {}, a: { is_system: false }, b: {} }),
      ).toBe(false);
    });
  }

  it("still reconciles a customer's own relationship type", () => {
    // The exclusion must not swallow the work reconciliation exists to do.
    expect(
      filterAccepts({
        type: "MENTIONS",
        r: { confidence: 0.4 },
        a: { is_system: false },
        b: { is_system: false },
      }),
    ).toBe(true);
  });

  it("still honours the marker for a platform type the list has not learned", () => {
    // The three parts are layered, not alternatives: a future platform writer
    // that sets is_system is covered before anyone adds its type here.
    expect(
      filterAccepts({
        type: "NOT_YET_ENUMERATED",
        r: { is_system: true },
        a: {},
        b: {},
      }),
    ).toBe(false);
  });

  it("still honours a system endpoint", () => {
    // The backstop half: a customer-named type hanging off a platform node is
    // still not reconciled.
    expect(
      filterAccepts({ type: "MENTIONS", r: {}, a: { is_system: true }, b: {} }),
    ).toBe(false);
  });
});

describe("the platform relationship-type list cannot drift from its rationale", () => {
  const source = readFileSync(
    new URL("./schema.reconcile.ts", import.meta.url),
    "utf8",
  );

  it("matches the writer enumeration in the doc comment", () => {
    // The doc comment argues the set is closed and names each writer. If a
    // fifth platform writer is documented and not listed, the filter would let
    // its edges through; if listed and not documented, the argument for
    // excluding them is gone. Neither may happen quietly.
    const documented = [...source.matchAll(/^\s*\*\s+-\s+`([A-Z_]+)`/gm)].map(
      (m) => m[1]!,
    );
    expect([...new Set(documented)].sort()).toEqual(
      [...PLATFORM_RELATIONSHIP_TYPES].sort(),
    );
  });

  it("supplies the parameter everywhere the filter is embedded", () => {
    // The filter references $platformRelTypes. A query that embeds it without
    // passing the list fails at the driver, which is the wrong place to find
    // out — so every embedding site is checked here instead.
    const calls = source.split("session.run(").slice(1);
    const embedding = calls.filter((chunk) =>
      /NON_SYSTEM_RELATIONSHIP_FILTER|RELATIONSHIP_WRITE_BACK_CYPHER/.test(
        chunk.slice(0, 1200),
      ),
    );
    expect(embedding.length).toBe(3);
    for (const chunk of embedding) {
      expect(chunk.slice(0, 1600)).toContain("...PLATFORM_REL_TYPE_PARAMS");
    }
  });

  it("carries the list as a parameter, never as interpolated query text", () => {
    expect(PLATFORM_REL_TYPE_PARAMS).toEqual({
      [PLATFORM_REL_TYPES_PARAM]: PLATFORM_RELATIONSHIP_TYPES,
    });
    expect(NON_SYSTEM_RELATIONSHIP_FILTER).toContain(
      `NOT type(r) IN $${PLATFORM_REL_TYPES_PARAM}`,
    );
    for (const type of PLATFORM_RELATIONSHIP_TYPES) {
      expect(RELATIONSHIP_WRITE_BACK_CYPHER).not.toContain(type);
    }
  });
});
