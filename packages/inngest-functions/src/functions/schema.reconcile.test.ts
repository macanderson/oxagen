import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countOf } from "../lib/driver-count";
import {
  buildPrunedProperties,
  buildRelationshipWriteBackProps,
  NON_SYSTEM_RELATIONSHIP_FILTER,
  parseNodeProps,
  FAR_ENDPOINT_TENANT_FILTER,
  PLATFORM_REL_TYPE_PARAMS,
  PLATFORM_REL_TYPES_PARAM,
  PLATFORM_RELATIONSHIP_TYPES,
  RELATIONSHIP_WRITE_BACK_CYPHER,
  REIDENTIFIABLE_ENDPOINTS_FILTER,
  RESERVED_RELATIONSHIP_PROPERTY_KEYS,
  stripReservedRelationshipKeys,
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

/**
 * Source with `//` comment lines removed, for the structural assertions below.
 *
 * They count occurrences of query text, and a doc comment that DESCRIBES the
 * query — "ORDER BY gives the pages a defined boundary" — counts as one. That
 * is a test failing on prose, which teaches the next author to write less of
 * it. Comments are stripped so these assertions read code.
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

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
    const calls = codeOnly(source).split("session.run(").slice(1);
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

// ── A property name is not a place to invoke a setter ────────────────────────

/**
 * What the Bolt driver actually sends: a parameter map is serialised from the
 * object's OWN ENUMERABLE keys. Asserting through this rather than reading the
 * property back is the whole point — `props["__proto__"]` returns the object's
 * PROTOTYPE, so `expect(props["__proto__"]).toBeNull()` passes on the broken
 * construction and proves nothing.
 */
function asDriverWouldSerialize(
  params: Record<string, unknown>,
): Array<[string, unknown]> {
  return Object.entries(params);
}

describe("a property named __proto__ survives into the parameter map", () => {
  it("carries the removal instruction the driver has to see", () => {
    const props = buildRelationshipWriteBackProps({ confidence: 0.9 }, [
      "__proto__",
    ]);

    // The assertion that was red before the fix. On a `{}` bag the assignment
    // invoked the prototype setter, so the key never became an own property:
    // nothing reached Neo4j, the property stayed on the edge, and the job
    // counted it pruned and reported success.
    expect(asDriverWouldSerialize(props)).toContainEqual(["__proto__", null]);
    expect(Object.keys(props)).toContain("__proto__");
    expect(Object.prototype.hasOwnProperty.call(props, "__proto__")).toBe(true);
  });

  it("keeps a retained property of that name instead of dropping it", () => {
    // The same defect on the other loop, and the quieter half: the value would
    // vanish from the write-back with no counter to notice.
    const retained: Record<string, unknown> = { ["__proto__"]: "keep-me" };
    const props = buildRelationshipWriteBackProps(retained, []);
    expect(asDriverWouldSerialize(props)).toContainEqual([
      "__proto__",
      "keep-me",
    ]);
  });

  it("keeps a schema-declared property of that name through the prune", () => {
    const existing: Record<string, unknown> = {
      ["__proto__"]: "declared",
      off: 1,
    };
    const { pruned, removedKeys } = buildPrunedProperties(existing, [
      "__proto__",
    ]);
    expect(Object.keys(pruned)).toContain("__proto__");
    expect(removedKeys).toEqual(["off"]);
  });

  it("reaches the builders the way a real node does, via JSON.parse", () => {
    // Reachability without needing a hostile schema name: JSON.parse DEFINES
    // rather than assigns, so a node whose canonical `properties` blob carries
    // the key hands an own property straight in.
    const fromGraph = parseNodeProps('{"__proto__": 1, "kept": 2}');
    expect(Object.keys(fromGraph)).toContain("__proto__");

    const { removedKeys } = buildPrunedProperties(fromGraph, ["kept"]);
    expect(removedKeys).toEqual(["__proto__"]);
    expect(
      asDriverWouldSerialize(buildRelationshipWriteBackProps({}, removedKeys)),
    ).toContainEqual(["__proto__", null]);
  });

  it("needs no list of dangerous names — the prototype is gone entirely", () => {
    // `constructor` and `prototype` are ordinary own keys and were never the
    // problem; the point of fixing the construction is that there is no next
    // name to add. A null-prototype bag inherits nothing at all.
    const props = buildRelationshipWriteBackProps({}, [
      "__proto__",
      "constructor",
      "prototype",
      "toString",
    ]);
    expect(Object.keys(props).sort()).toEqual([
      "__proto__",
      "constructor",
      "prototype",
      "toString",
    ]);
    expect(Object.getPrototypeOf(props)).toBeNull();
    expect("toString" in props).toBe(true);
  });
});

// ── An element id is not an identity ─────────────────────────────────────────

describe("the relationship write-back re-identifies before it mutates", () => {
  const source = readFileSync(
    new URL("./schema.reconcile.ts", import.meta.url),
    "utf8",
  );

  it("keys on data the element id cannot fake", () => {
    // Neo4j's manual: an element id is unique "within the scope of a single
    // transaction", and outside one "no guarantees are given about the mapping
    // between ID values and elements. Neo4j reuses its internal IDs when nodes
    // and relationships are deleted." Every session.run here is its own
    // auto-commit transaction and the loop makes an LLM call between the read
    // and the write, so the window is real. `SET r += $props` carries
    // null-valued REMOVALS, so a mis-identified relationship loses properties.
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain("type(r) = $relType");
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain("a.publicId = $startId");
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain("b.publicId = $endId");
    // Still anchored to the tenant and still off platform edges.
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain("a.orgId = $orgId");
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain(
      NON_SYSTEM_RELATIONSHIP_FILTER,
    );
  });

  it("reports whether it matched anything at all", () => {
    // A verification that silently skips is the same defect in a new place.
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain(
      "RETURN count(r) AS written",
    );
  });

  it("reads the keys it verifies against in the same batch", () => {
    // The write can only check `a.publicId`/`b.publicId` if the read returned
    // them; a re-identification keyed on values nobody selected matches nothing
    // and would skip every write.
    expect(source).toContain("a.publicId AS startId, b.publicId AS endId");
  });

  it("counts a prune only where the write confirmed it", () => {
    // Both counters used to fire regardless: `prunedRelationships++` inside the
    // prune block before the write ran at all, and `updatedRelationships++`
    // straight after `session.run` whether or not it matched. Each must now sit
    // inside the confirmed-write branch, or the job reports a prune it did not
    // perform — which is the failure this whole path is being hardened against.
    const guard = source.indexOf(
      'countOf(writeResult.records[0]?.get("written"))',
    );
    expect(guard).toBeGreaterThan(-1);

    for (const counter of ["updatedRelationships++", "prunedRelationships++"]) {
      const occurrences = source.split(counter).length - 1;
      expect(occurrences, `${counter} should appear once`).toBe(1);
      expect(
        source.indexOf(counter),
        `${counter} must sit after the confirmed-write guard`,
      ).toBeGreaterThan(guard);
    }
  });
});

describe("countOf — a Bolt count is not a JS number", () => {
  it("is why `written > 0` cannot be read off the raw value", () => {
    // The driver returns count() as a 64-bit Integer OBJECT. Comparing it
    // directly is comparing against an object, and an object is truthy — a
    // zero-match write would have read as a successful one.
    const driverZero = { toNumber: () => 0, low: 0, high: 0 };
    expect(Boolean(driverZero)).toBe(true);
    expect(countOf(driverZero)).toBe(0);
    expect(countOf(driverZero) > 0).toBe(false);
  });

  it("reads a real match, and coerces anything unreadable to nothing", () => {
    expect(countOf({ toNumber: () => 3 })).toBe(3);
    expect(countOf(2)).toBe(2);
    expect(countOf(2n)).toBe(2);
    // Conservative direction: a count that cannot be read is not a write.
    expect(countOf(undefined)).toBe(0);
    expect(countOf(null)).toBe(0);
    expect(countOf("7")).toBe(0);
    expect(countOf(Number.NaN)).toBe(0);
    expect(countOf({ toNumber: () => Number.NaN })).toBe(0);
  });
});

// ── publicId says WHICH node, not WHOSE ──────────────────────────────────────

interface Endpoint {
  orgId: string;
  workspaceId: string;
}

const ORG = "org-in-scope";
const WS = "ws-in-scope";

/**
 * The near-endpoint anchor as the three queries write it out. It is a literal
 * here for the same reason it is a literal there — the repo corpus test in
 * `@oxagen/ontology` reads the static query text and a template hole is opaque
 * to it — and `every relationship site anchors both endpoints` below asserts
 * this exact string precedes the shared far-endpoint constant at all three
 * sites, so evaluating it is evaluating what ships.
 */
const NEAR_ENDPOINT_TENANT_FILTER =
  "a.orgId = $orgId AND a.workspaceId = $workspaceId";

/**
 * Evaluate the SHIPPED endpoint anchors against one candidate row, the way
 * Neo4j would. Asserting that a string contains a clause tests the spelling;
 * this tests the decision, and it is what lets the org predicate and the
 * workspace predicate be shown to be INDEPENDENTLY load-bearing — a
 * string-contains test cannot tell a same-org-different-workspace row from a
 * different-org one.
 *
 * An unrecognised conjunct THROWS rather than being skipped, so a later edit
 * cannot make these assertions vacuous.
 */
function anchorAccepts(a: Endpoint, b: Endpoint): boolean {
  const endpoints: Record<string, Endpoint> = { a, b };
  const params: Record<string, string> = { orgId: ORG, workspaceId: WS };
  return `${NEAR_ENDPOINT_TENANT_FILTER} AND ${FAR_ENDPOINT_TENANT_FILTER}`
    .split(/\bAND\b/)
    .map((c) => c.trim().replace(/\s+/g, " "))
    .every((conjunct) => {
      const m = /^(a|b)\.(orgId|workspaceId) = \$(orgId|workspaceId)$/.exec(
        conjunct,
      );
      if (!m) {
        throw new Error(
          `anchorAccepts cannot evaluate "${conjunct}" — teach it the new ` +
            `clause rather than letting these assertions go vacuous.`,
        );
      }
      return endpoints[m[1]!]![m[2]! as keyof Endpoint] === params[m[3]!];
    });
}

describe("a relationship is only in scope when BOTH endpoints are", () => {
  const inScope: Endpoint = { orgId: ORG, workspaceId: WS };

  it("accepts an edge wholly inside the tenant", () => {
    expect(anchorAccepts(inScope, inScope)).toBe(true);
  });

  it("refuses an edge whose far endpoint is another ORGANISATION", () => {
    // A legacy, imported or BYO graph can hold one. `SET r += $props` carries
    // null-valued removals, so accepting it deletes another tenant's data.
    expect(
      anchorAccepts(inScope, { orgId: "org-other", workspaceId: WS }),
    ).toBe(false);
  });

  it("refuses an edge whose far endpoint is another WORKSPACE of the SAME org", () => {
    // Independently load-bearing: the org predicate passes for every workspace
    // in that org, so this row is refused only by the workspace predicate. One
    // test must not be able to cover for both.
    expect(
      anchorAccepts(inScope, { orgId: ORG, workspaceId: "ws-other" }),
    ).toBe(false);
  });

  it("refuses an edge whose far endpoint shares a workspace id across orgs", () => {
    // And the mirror: a workspace id is not unique across organisations, so
    // this row is refused only by the org predicate.
    expect(
      anchorAccepts(inScope, { orgId: "org-other", workspaceId: WS }),
    ).toBe(false);
  });

  it("refuses a near endpoint out of scope too", () => {
    expect(
      anchorAccepts({ orgId: "org-other", workspaceId: WS }, inScope),
    ).toBe(false);
    expect(
      anchorAccepts({ orgId: ORG, workspaceId: "ws-other" }, inScope),
    ).toBe(false);
  });
});

describe("every relationship site anchors both endpoints", () => {
  const source = readFileSync(
    new URL("./schema.reconcile.ts", import.meta.url),
    "utf8",
  );

  it("pairs the written-out near anchor with the shared far anchor", () => {
    // Three sites: the count, the batch read, and the write-back. The READ is
    // the first line of defence — it selects the rows, derives the removals
    // from them, and puts properties(r) into an LLM prompt — and the write-back
    // is the second. A guard on one is one the other's next edit steps around.
    const matches =
      source.split("MATCH (a:GraphNode)-[r]->(b:GraphNode)").length - 1;
    expect(matches).toBe(3);

    // Every occurrence of the near anchor is immediately followed by the far
    // one, which is also what makes `anchorAccepts` above evaluate what ships.
    const paired = [
      ...source.matchAll(
        /a\.orgId = \$orgId AND a\.workspaceId = \$workspaceId\s*\n\s*AND \$\{FAR_ENDPOINT_TENANT_FILTER\}/g,
      ),
    ];
    expect(paired.length).toBe(3);

    const nearOccurrences =
      source.split("a.orgId = $orgId AND a.workspaceId = $workspaceId").length -
      1;
    expect(
      nearOccurrences,
      "a near anchor without a far anchor beside it is the defect",
    ).toBe(3);
  });
});

// ── A model's extra key is not a customer property ───────────────────────────

describe("reserved relationship keys never reach the write", () => {
  it("strips every reserved key and keeps everything else", () => {
    const bag: Record<string, unknown> = { weight: 0.9, note: "keep" };
    for (const key of RESERVED_RELATIONSHIP_PROPERTY_KEYS) bag[key] = "taken";

    const { kept, stripped } = stripReservedRelationshipKeys(bag);
    expect(Object.keys(kept).sort()).toEqual(["note", "weight"]);
    expect(stripped.sort()).toEqual(
      [...RESERVED_RELATIONSHIP_PROPERTY_KEYS].sort(),
    );
  });

  it("keeps is_system out of the parameter map the driver sends", () => {
    // The reported route: derivation returns is_system, the write persists it,
    // and NON_SYSTEM_RELATIONSHIP_FILTER then excludes that customer edge from
    // every later reconciliation.
    const props = buildRelationshipWriteBackProps(
      { weight: 0.9, is_system: true },
      [],
    );
    expect(Object.keys(props)).toEqual(["weight"]);
    expect(Object.entries(props)).not.toContainEqual(["is_system", true]);
  });

  it("leaves a reserved key alone rather than re-writing it", () => {
    // `SET r += $props` MERGES, so a key the map does not mention is left
    // exactly as it is. That IS retention, and it is better than re-writing the
    // value the read happened to see.
    const props = buildRelationshipWriteBackProps(
      { weight: 0.9, orgId: "org-1", createdAt: "2026-01-01T00:00:00Z" },
      [],
    );
    expect(Object.keys(props)).toEqual(["weight"]);
  });

  it("is what makes the loop unable to move a row out of its own batch", () => {
    // The structural claim, stated as an assertion: the selection predicate
    // reads only type(r) (immutable), the endpoints (the write touches neither)
    // and r.is_system — and no reserved key can reach $props from any source.
    const hostile: Record<string, unknown> = { weight: 1 };
    for (const key of RESERVED_RELATIONSHIP_PROPERTY_KEYS) hostile[key] = true;
    const written = Object.keys(buildRelationshipWriteBackProps(hostile, []));
    for (const key of RESERVED_RELATIONSHIP_PROPERTY_KEYS) {
      expect(written).not.toContain(key);
    }
  });
});

describe("the batch reads have a defined page boundary", () => {
  const source = readFileSync(
    new URL("./schema.reconcile.ts", import.meta.url),
    "utf8",
  );

  it("orders both paginated reads before SKIP", () => {
    // Cypher guarantees NO row order without ORDER BY, so consecutive SKIP
    // windows can overlap or omit rows even with nothing mutating.
    // Checked by ADJACENCY rather than by counting: every `SKIP` must have an
    // `ORDER BY` as the line directly above it. Counting both and comparing
    // would pass if someone added a third ordered query and an unordered
    // paginated one in the same change.
    const lines = codeOnly(source).split("\n");
    const paginated = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes("SKIP $skip LIMIT $batchSize"));

    expect(paginated.length).toBe(2);
    for (const { i } of paginated) {
      expect(
        lines[i - 1]?.trim(),
        `the read at line ${i + 1} paginates with no defined order`,
      ).toMatch(/^ORDER BY /);
    }
    expect(lines[paginated[0]!.i - 1]?.trim()).toBe("ORDER BY nodeId");
    expect(lines[paginated[1]!.i - 1]?.trim()).toBe(
      "ORDER BY startId, endId, relType, relElemId",
    );
  });
});

// ── publicId can be ABSENT, and the write-back cannot re-identify without it ──

describe("an edge the write-back could never re-identify is not selected", () => {
  const source = readFileSync(
    new URL("./schema.reconcile.ts", import.meta.url),
    "utf8",
  );

  /** An endpoint as the batch read sees it: tenant, plus the id it re-identifies by. */
  interface ReadEndpoint {
    orgId: string;
    workspaceId: string;
    publicId: string | null;
  }

  /**
   * Evaluate the batch read's SHIPPED predicate against one candidate row.
   *
   * The conjuncts are lifted out of the query text in schema.reconcile.ts, with
   * the shared constants substituted for their template holes, so this
   * evaluates what actually runs rather than a copy that can drift. Anything it
   * cannot parse THROWS, so a later edit cannot make these assertions vacuous.
   */
  function batchReadAccepts(a: ReadEndpoint, b: ReadEndpoint): boolean {
    const start = source.indexOf(
      "RETURN elementId(r) AS relElemId, type(r) AS relType",
    );
    expect(start, "the relationship batch read moved").toBeGreaterThan(-1);
    const whereAt = source.lastIndexOf(
      "WHERE a.orgId = $orgId AND a.workspaceId = $workspaceId",
      start,
    );
    expect(whereAt, "the relationship batch read has no WHERE").toBeGreaterThan(
      -1,
    );

    const endpoints: Record<string, ReadEndpoint> = { a, b };
    const params: Record<string, string> = { orgId: ORG, workspaceId: WS };

    return source
      .slice(whereAt, start)
      .replace("${FAR_ENDPOINT_TENANT_FILTER}", FAR_ENDPOINT_TENANT_FILTER)
      .replace(
        "${REIDENTIFIABLE_ENDPOINTS_FILTER}",
        REIDENTIFIABLE_ENDPOINTS_FILTER,
      )
      .replace(/^\s*WHERE\b/, "")
      .split("\n")
      .map((line) => line.trim())
      .join(" ")
      .split(/\bAND\b/)
      .map((c) => c.trim().replace(/\s+/g, " "))
      .filter((c) => c.length > 0)
      .every((conjunct) => {
        const tenant =
          /^(a|b)\.(orgId|workspaceId) = \$(orgId|workspaceId)$/.exec(conjunct);
        if (tenant) {
          return (
            endpoints[tenant[1]!]![tenant[2]! as "orgId" | "workspaceId"] ===
            params[tenant[3]!]
          );
        }
        const notNull = /^(a|b)\.publicId IS NOT NULL$/.exec(conjunct);
        if (notNull) return endpoints[notNull[1]!]!.publicId !== null;
        // The type and is_system conjuncts are not this test's subject; they
        // are pinned by their own describes above and are held constant here.
        if (
          conjunct.startsWith("type(r) IN $relTypes") ||
          conjunct.includes("NON_SYSTEM_RELATIONSHIP_FILTER")
        ) {
          return true;
        }
        throw new Error(
          `batchReadAccepts cannot evaluate "${conjunct}" — teach it the new ` +
            `clause rather than letting these assertions go vacuous.`,
        );
      });
  }

  const identified: ReadEndpoint = {
    orgId: ORG,
    workspaceId: WS,
    publicId: "node-a",
  };

  it("selects an edge whose endpoints both carry a publicId", () => {
    expect(
      batchReadAccepts(identified, { ...identified, publicId: "node-b" }),
    ).toBe(true);
  });

  it("refuses an edge whose START endpoint carries no publicId", () => {
    // `graph_node_public_id` is REQUIRE n.publicId IS UNIQUE — a UNIQUENESS
    // constraint, which Neo4j simply does not apply to a node missing the
    // property. It is not an existence constraint (Enterprise-only), so the
    // legacy / imported / BYO graph this file already anchors both endpoints
    // against is exactly the graph that can hold one.
    expect(
      batchReadAccepts({ ...identified, publicId: null }, identified),
    ).toBe(false);
  });

  it("refuses an edge whose END endpoint carries no publicId", () => {
    expect(
      batchReadAccepts(identified, { ...identified, publicId: null }),
    ).toBe(false);
  });

  it("still refuses an out-of-tenant endpoint that DOES carry a publicId", () => {
    // The new predicate must not be able to stand in for the tenant anchors:
    // an identified endpoint in another org or another workspace is still out.
    expect(
      batchReadAccepts(identified, { ...identified, orgId: "org-other" }),
    ).toBe(false);
    expect(
      batchReadAccepts(identified, { ...identified, workspaceId: "ws-other" }),
    ).toBe(false);
  });

  it("is why selecting such an edge would be a silent no-op, not an error", () => {
    // The harm, made executable. The write-back re-identifies with
    // `a.publicId = $startId`. Cypher's three-valued logic makes a comparison
    // against a null parameter NULL — not true, and not an error — so the write
    // matches nothing, `written` is 0, and the loop logs a warning and moves
    // on while STILL advancing processedRelationships. The job then finalises
    // with processed == total, reporting a reconcile it never performed.
    expect(RELATIONSHIP_WRITE_BACK_CYPHER).toContain(
      "a.publicId = $startId AND b.publicId = $endId",
    );
    const cypherEquals = (left: string | null, right: string | null) =>
      left === null || right === null ? null : left === right;
    expect(cypherEquals(null, "node-a")).toBeNull();
    expect(cypherEquals(null, null)).toBeNull();
    expect(Boolean(cypherEquals(null, null))).toBe(false);
  });
});

describe("the excluded edges are counted rather than disappearing", () => {
  const source = codeOnly(
    readFileSync(new URL("./schema.reconcile.ts", import.meta.url), "utf8"),
  );

  it("narrows the READ but not the COUNT, and subtracts instead", () => {
    // If the count were narrowed the same way, `totalRelationships` would match
    // `processedRelationships` and the excluded rows would be invisible —
    // indistinguishable from a graph that simply had nothing to reconcile.
    // Counting them and subtracting reports both numbers honestly.
    const reads =
      source.split("AND ${REIDENTIFIABLE_ENDPOINTS_FILTER}").length - 1;
    expect(reads, "the filter belongs on the batch read only").toBe(1);

    const counts =
      source.split("${UNRECONCILABLE_RELATIONSHIP_COUNT} AS unreconcilable")
        .length - 1;
    expect(counts, "the count query must project the exclusion").toBe(1);

    expect(source).toContain("totalRelationships = matched - unreconcilable");
  });

  it("counts exactly the rows the read filter removes", () => {
    // `count(CASE WHEN … END)` counts non-null results only, so the projection
    // is the complement of the read filter over the same matched set — which is
    // what makes `matched - unreconcilable` the number the run will attempt.
    const rows: Array<[string | null, string | null]> = [
      ["a", "b"],
      [null, "b"],
      ["a", null],
      [null, null],
    ];
    const excluded = rows.filter(([a, b]) => a === null || b === null).length;
    const selected = rows.filter(([a, b]) => a !== null && b !== null).length;
    expect(excluded).toBe(3);
    expect(selected).toBe(1);
    expect(selected + excluded).toBe(rows.length);
  });
});
