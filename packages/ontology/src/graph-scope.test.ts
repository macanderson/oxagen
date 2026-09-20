import { describe, expect, it } from "vitest";
import {
  applyGraphScope,
  assertNoReservedParamCollision,
  assertReadOnly,
  assertScopeMarkers,
  buildScopeParams,
  clampLimits,
  clampVarLengthHops,
  expressionLocalBindings,
  GraphScopeError,
  keepFilteringPositions,
  keepPredicatePositions,
  projectedNames,
  rowSelectingParts,
  rowSelectingScope,
  SCOPE_LABELS_PARAM,
  SCOPE_REL_TYPES_PARAM,
  scanLiteralsAndComments,
  stripLiteralsAndComments,
  type GraphScope,
} from "./graph-scope";

describe("GraphScopeError", () => {
  it("is an Error with a stable code and name", () => {
    const err = new GraphScopeError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("graph_scope_violation");
    expect(err.name).toBe("GraphScopeError");
    expect(err.message).toBe("boom");
  });
});

describe("stripLiteralsAndComments", () => {
  it("blanks single/double quoted strings, backtick ids, and comments", () => {
    const out = stripLiteralsAndComments(
      "MATCH (n:`My Label`) WHERE n.a = 'CREATE' AND n.b = \"MERGE\" // SET x\nRETURN n /* DELETE */",
    );
    expect(out).not.toMatch(/CREATE|MERGE|DELETE|SET/);
    expect(out).toContain("MATCH");
    expect(out).toContain("RETURN n");
  });

  it("does not let a `//` inside a string literal swallow the rest of the line", () => {
    // A URL literal contains `//`. A comment-first pass would delete everything
    // after `http:`, hiding the CREATE from the write-keyword scan.
    const out = stripLiteralsAndComments(
      "MATCH (n {u:'http://example.com/x'}) CREATE (m)",
    );
    expect(out).toContain("CREATE");
    expect(out).not.toContain("example.com");
  });

  it("does not let an apostrophe inside a comment swallow the next literal", () => {
    const out = stripLiteralsAndComments(
      "// don't do this\nMATCH (n) WHERE n.a = 'CREATE' RETURN n",
    );
    expect(out).not.toMatch(/CREATE/);
    expect(out).toContain("RETURN n");
  });
});

describe("assertReadOnly", () => {
  it("passes a pure read query", () => {
    expect(() =>
      assertReadOnly("MATCH (n:Doc) WHERE n.orgId = $orgId RETURN n"),
    ).not.toThrow();
  });

  it.each(["CREATE", "MERGE", "SET", "DELETE", "REMOVE", "FOREACH"])(
    "rejects a %s write clause",
    (kw) => {
      expect(() =>
        assertReadOnly(`MATCH (n) WHERE n.orgId = $orgId ${kw} (m)`),
      ).toThrow(GraphScopeError);
    },
  );

  it("rejects DETACH DELETE", () => {
    expect(() =>
      assertReadOnly("MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n"),
    ).toThrow(GraphScopeError);
  });

  it("rejects a mutating apoc.create CALL", () => {
    expect(() =>
      assertReadOnly(
        "MATCH (n) WHERE n.orgId = $orgId CALL apoc.create.node(['X'], {}) YIELD node RETURN node",
      ),
    ).toThrow(GraphScopeError);
  });

  it("does not false-reject a keyword inside a string literal", () => {
    expect(() =>
      assertReadOnly("MATCH (n) WHERE n.name = 'CREATE TABLE' RETURN n"),
    ).not.toThrow();
  });

  it("does not false-reject a keyword inside a comment", () => {
    expect(() =>
      assertReadOnly("// we CREATE nothing here\nMATCH (n) RETURN n"),
    ).not.toThrow();
  });

  it("does not false-reject property names that embed a keyword", () => {
    // createdAt / assetId embed CREATE / SET but are not word-boundary matches.
    expect(() =>
      assertReadOnly("MATCH (n) RETURN n.createdAt, n.assetId, n.resultSet"),
    ).not.toThrow();
  });
});

describe("assertScopeMarkers", () => {
  const withMarkers = (labels: boolean, rels: boolean): GraphScope => ({
    ...(labels ? { labels: ["Doc"] } : {}),
    ...(rels ? { relationshipTypes: ["REFERS_TO"] } : {}),
  });

  it("passes when the constrained dimensions reference their markers", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE any(l IN labels(n) WHERE l IN $${SCOPE_LABELS_PARAM}) RETURN n`,
        withMarkers(true, false),
      ),
    ).not.toThrow();
  });

  it("throws when a labels-constrained query omits the labels marker", () => {
    expect(() =>
      assertScopeMarkers("MATCH (n) RETURN n", withMarkers(true, false)),
    ).toThrow(/\$__scopeLabels/);
  });

  it("throws when a rel-type-constrained query omits the rel-type marker", () => {
    expect(() =>
      assertScopeMarkers(
        "MATCH (a)-[r]->(b) RETURN r",
        withMarkers(false, true),
      ),
    ).toThrow(/\$__scopeRelTypes/);
  });

  it("does not require markers for unconstrained dimensions", () => {
    expect(() => assertScopeMarkers("MATCH (n) RETURN n", {})).not.toThrow();
  });

  it("treats a marker mentioned only in a comment as absent", () => {
    expect(() =>
      assertScopeMarkers(
        `// filtered elsewhere by $${SCOPE_LABELS_PARAM}\nMATCH (n) RETURN n`,
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
  });

  it("treats a marker mentioned only in a string literal as absent", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (a)-[r]->(b) WHERE b.note = '$${SCOPE_REL_TYPES_PARAM}' RETURN r`,
        withMarkers(false, true),
      ),
    ).toThrow(GraphScopeError);
  });

  // Discriminating: each of these mentions the marker where the OLD presence
  // check (`/\$__scopeLabels\b/` anywhere in the sanitized text) accepted it,
  // while nothing is actually filtered by the allow-list.
  // The reviewer's counterexample, and its relationship twin. Both satisfy the
  // shipped `IN $__scopeLabels` membership regex and return every node,
  // including the labels the agent may not see, because an aliased predicate in
  // a projection narrows nothing.
  it("treats an aliased membership in a RETURN as absent", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) RETURN n, n.label IN $${SCOPE_LABELS_PARAM} AS allowed`,
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
  });

  it("treats an aliased relationship membership in a RETURN as absent", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (a)-[r]->(b) RETURN r, type(r) IN $${SCOPE_REL_TYPES_PARAM} AS allowed`,
        withMarkers(false, true),
      ),
    ).toThrow(GraphScopeError);
  });

  it("treats an aliased membership in a WITH as absent", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WITH n, any(l IN labels(n) WHERE l IN $${SCOPE_LABELS_PARAM}) AS ok RETURN n`,
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
  });

  // Round-three review. `keepFilteringPositions` rejected a bare
  // `RETURN … AS allowed`, then re-admitted the same defect through a map
  // literal nested in a call or a list, because `paren > 0 || bracket > 0` is a
  // proxy for "inside a pattern" and a proxy admits everything shaped like it.
  // Each of these is tenant-scoped and label-UNscoped: the tenancy guard passes
  // and every node comes back regardless of the agent's label allowance.
  const projectionMaps: Array<[name: string, cypher: string]> = [
    [
      "map inside head([…])",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n, head([{allowed: n.label IN $__scopeLabels}])",
    ],
    [
      "map inside a bare list literal",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n, [{allowed: n.label IN $__scopeLabels}]",
    ],
    [
      "map inside a function call",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n, collect({allowed: n.label IN $__scopeLabels})",
    ],
    [
      "map inside a list comprehension",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n, [x IN $xs | {allowed: n.label IN $__scopeLabels}]",
    ],
    [
      "map literal in a WITH projection",
      "MATCH (n) WHERE n.orgId = $orgId WITH n, {allowed: n.label IN $__scopeLabels} AS m RETURN n",
    ],
    [
      "map inside a call nested inside a real pattern's parens",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n, head([{ok: n.label IN $__scopeLabels}]) AS h",
    ],
  ];

  for (const [name, cypher] of projectionMaps) {
    it(`treats a map in a projection as absent: ${name}`, () => {
      expect(() =>
        assertScopeMarkers(cypher, withMarkers(true, false)),
      ).toThrow(GraphScopeError);
    });
  }

  it("still accepts a genuine relationship-pattern property map", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (a)-[r:T {k: 1}]->(b) WHERE type(r) IN $${SCOPE_REL_TYPES_PARAM} RETURN r`,
        withMarkers(false, true),
      ),
    ).not.toThrow();
  });

  it("treats a marker in a RETURN projection as absent (not a filter)", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) RETURN n, $${SCOPE_LABELS_PARAM} AS allowed`,
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
  });

  it("treats a marker in a size() expression as absent (not a filter)", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (a)-[r]->(b) RETURN r, size($${SCOPE_REL_TYPES_PARAM}) AS n`,
        withMarkers(false, true),
      ),
    ).toThrow(GraphScopeError);
  });

  it("treats a marker bound by WITH but never applied as absent", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WITH n, $${SCOPE_LABELS_PARAM} AS allowed RETURN n`,
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
  });

  it("accepts the membership forms the handlers actually write", () => {
    for (const cypher of [
      `MATCH (n) WHERE n.label IN $${SCOPE_LABELS_PARAM} RETURN n`,
      `MATCH (n) WHERE any(l IN labels(n) WHERE l IN $${SCOPE_LABELS_PARAM}) RETURN n`,
      `MATCH (n) WHERE ALL(x IN nodes(p) WHERE any(l IN labels(x) WHERE l IN $${SCOPE_LABELS_PARAM})) RETURN n`,
    ]) {
      expect(() =>
        assertScopeMarkers(cypher, withMarkers(true, false)),
      ).not.toThrow();
    }
    for (const cypher of [
      `MATCH (a)-[r]->(b) WHERE type(r) IN $${SCOPE_REL_TYPES_PARAM} RETURN r`,
      `MATCH p=(a)-[*]->(b) WHERE ALL(rel IN relationships(p) WHERE type(rel) IN $${SCOPE_REL_TYPES_PARAM}) RETURN b`,
    ]) {
      expect(() =>
        assertScopeMarkers(cypher, withMarkers(false, true)),
      ).not.toThrow();
    }
  });

  // Round four. `CREATE` was excluded from ROW_SELECTING_CLAUSES because its
  // map stamps a node being made; `MERGE` was kept, and it has the same hole in
  // the same shape. `MERGE (audit {allowed: n.label IN $__scopeLabels})` is a
  // match-or-create predicate on `audit` and says nothing about `n`, which the
  // MATCH already bound — so the query returns every tenant-local label under a
  // constrained scope. MERGE now counts only when nothing before it bound a
  // graph variable, which is the case where there is nothing else to scope.
  const mergeMaps: Array<[name: string, cypher: string]> = [
    [
      "the reported shape: a MERGE map beside an anchored MATCH",
      "MATCH (n:GraphNode {orgId: $orgId}) MERGE (audit {allowed: n.label IN $__scopeLabels}) RETURN n",
    ],
    [
      "MERGE map on a relationship pattern after a MATCH",
      "MATCH (a)-[r]->(b) MERGE (x)-[q:AUDIT {ok: type(r) IN $__scopeRelTypes}]->(y) RETURN r",
    ],
    [
      "MERGE map after an OPTIONAL MATCH",
      "OPTIONAL MATCH (n) MERGE (audit {allowed: n.label IN $__scopeLabels}) RETURN n",
    ],
    [
      "second MERGE map, the first having bound a variable",
      "MERGE (a:Thing {k: $k}) MERGE (audit {allowed: a.label IN $__scopeLabels}) RETURN a",
    ],
  ];

  for (const [name, cypher] of mergeMaps) {
    it(`treats a MERGE map that narrows nothing already bound as absent: ${name}`, () => {
      const scope = /RelTypes/.test(cypher)
        ? withMarkers(false, true)
        : withMarkers(true, false);
      expect(() => assertScopeMarkers(cypher, scope)).toThrow(GraphScopeError);
    });
  }

  it("rejects a MERGE map even when the MERGE is the first graph clause", () => {
    // ROUND EIGHT inverts what round 7 asserted here. Round 7's reasoning was
    // about the TENANCY guard's question — every variable in a first-clause
    // MERGE pattern is new, so `{orgId: $orgId}` does anchor all of them. It
    // does not carry over to a MEMBERSHIP TEST, whose whole contribution is the
    // boolean it evaluates to: as a map VALUE that boolean is stored in a
    // property and refuses nothing, so the node is created with its
    // out-of-mandate label either way. See the round-eight block below.
    expect(() =>
      assertScopeMarkers(
        `MERGE (n:GraphNode {orgId: $orgId, ok: n.label IN $${SCOPE_LABELS_PARAM}}) RETURN n`,
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
  });

  it("treats a prefix-collision marker as absent (word boundary)", () => {
    expect(() =>
      assertScopeMarkers(
        "MATCH (n) WHERE n.x = $__scopeLabelsExtra RETURN n",
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
  });
});

// ── Round eight: an inert predicate is not enforcement ───────────────────────
//
// Rounds 1-7 each closed one SPELLING of "the marker is present but narrows
// nothing". The rule underneath all of them: a membership test contributes
// exactly one thing, the BOOLEAN it evaluates to, so it counts only in a
// position where a FALSE can refuse a row. A WHERE clause is such a position.
// A pattern property VALUE is not — the boolean is stored in a property, the
// pattern still matches or still creates, and the row still comes back.
describe("assertScopeMarkers — a membership test as a pattern-property value", () => {
  const scoped = (labels: boolean): GraphScope =>
    labels ? { labels: ["Doc"] } : { relationshipTypes: ["REFERS_TO"] };

  it("rejects the reported query verbatim", () => {
    // The reviewer's exact text. A guard that rejects a paraphrase but accepts
    // this has not been fixed, so it is pinned here character for character.
    const reported =
      "WITH 'Forbidden' AS label MERGE (n:Forbidden {orgId: $orgId, allowed: label IN $__scopeLabels}) RETURN n";
    expect(() => assertScopeMarkers(reported, scoped(true))).toThrow(
      GraphScopeError,
    );
    expect(() => assertScopeMarkers(reported, scoped(true))).toThrow(
      /\$__scopeLabels/,
    );
  });

  const inertValuePositions: Array<
    [name: string, cypher: string, labels: boolean]
  > = [
    [
      "first-clause MERGE, no prior graph binding (round 7's exception)",
      `MERGE (n:Forbidden {orgId: $orgId, ok: n.label IN $${SCOPE_LABELS_PARAM}}) RETURN n`,
      true,
    ],
    [
      "MATCH map — the value constrains n.allowed, not n's labels",
      `MATCH (n {allowed: n.label IN $${SCOPE_LABELS_PARAM}}) RETURN n`,
      true,
    ],
    [
      "OPTIONAL MATCH map",
      `OPTIONAL MATCH (n {allowed: n.label IN $${SCOPE_LABELS_PARAM}}) RETURN n`,
      true,
    ],
    [
      "CREATE map",
      `CREATE (n:Forbidden {ok: n.label IN $${SCOPE_LABELS_PARAM}}) RETURN n`,
      true,
    ],
    [
      "relationship-pattern map on a first-clause MERGE",
      `MERGE (a)-[q:AUDIT {ok: type(q) IN $${SCOPE_REL_TYPES_PARAM}}]->(b) RETURN q`,
      false,
    ],
    [
      "WITH launders the binding, then a first-clause MERGE (the reported shape)",
      `WITH 1 AS x MERGE (n:Forbidden {ok: n.label IN $${SCOPE_LABELS_PARAM}}) RETURN n`,
      true,
    ],
    [
      "UNWIND launders the binding the same way",
      `UNWIND [1] AS x MERGE (n:Forbidden {ok: n.label IN $${SCOPE_LABELS_PARAM}}) RETURN n`,
      true,
    ],
  ];

  for (const [name, cypher, labels] of inertValuePositions) {
    it(`treats the marker as absent: ${name}`, () => {
      expect(() => assertScopeMarkers(cypher, scoped(labels))).toThrow(
        GraphScopeError,
      );
    });
  }

  it("leaves the tenancy projection alone — round 7 is not undone", () => {
    // The stricter rule belongs to the SCOPE guard's question (a boolean that
    // gates a row), not the TENANCY guard's (a property name bound to the
    // seam's own parameter). Dropping MERGE maps from the tenancy projection
    // rejects 5 of the 63 production queries the corpus test collects, so the
    // two projections stay separate.
    const merge = "MERGE (n:GraphNode {orgId: $orgId}) RETURN n";
    expect(keepFilteringPositions(merge)).toContain("orgId: $orgId");
    expect(keepPredicatePositions(merge)).not.toContain("orgId: $orgId");
  });
});

// The corpus cost of the stricter rule, measured rather than assumed. These are
// the only four sites in the tree that emit a scope marker — graph.search.ts,
// ontology.neighbors.ts and ontology.query.ts (twice) — each reproduced with
// the WHERE clause it is appended into. The stricter policy rejects 0 of 4.
describe("assertScopeMarkers — every production marker shape still passes", () => {
  const production: Array<[name: string, cypher: string, scope: GraphScope]> = [
    [
      "graph.search.ts — post-ANN label predicate after a CALL/YIELD",
      `CALL db.index.vector.queryNodes('graph_node_embedding_index', $k, $queryVector)
       YIELD node AS n, score
       WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
         AND n.is_system = false
         AND n.label IN $${SCOPE_LABELS_PARAM}
       RETURN n.publicId AS nodeId ORDER BY score DESC LIMIT 50`,
      { labels: ["Doc"] },
    ],
    [
      "ontology.neighbors.ts — any(l IN labels(m) WHERE l IN …)",
      `MATCH (n:GraphNode)-[r]-(m:GraphNode)
       WHERE n.orgId = $orgId
         AND any(l IN labels(m) WHERE l IN $${SCOPE_LABELS_PARAM})
       RETURN m LIMIT 50`,
      { labels: ["Doc"] },
    ],
    [
      "ontology.neighbors.ts — type(r) IN …",
      `MATCH (n:GraphNode)-[r]-(m:GraphNode)
       WHERE n.orgId = $orgId AND type(r) IN $${SCOPE_REL_TYPES_PARAM}
       RETURN m LIMIT 50`,
      { relationshipTypes: ["REFERS_TO"] },
    ],
    [
      "ontology.query.ts — ALL(n IN nodes(path) WHERE any(…))",
      `MATCH path = (a:GraphNode)-[*1..2]-(b:GraphNode)
       WHERE a.orgId = $orgId
         AND ALL(n IN nodes(path) WHERE any(l IN labels(n) WHERE l IN $${SCOPE_LABELS_PARAM}))
         AND ALL(rel IN relationships(path) WHERE type(rel) IN $${SCOPE_REL_TYPES_PARAM})
       RETURN path LIMIT 50`,
      { labels: ["Doc"], relationshipTypes: ["REFERS_TO"] },
    ],
  ];

  for (const [name, cypher, scope] of production) {
    it(`accepts ${name}`, () => {
      expect(() => assertScopeMarkers(cypher, scope)).not.toThrow();
    });
  }
});

// The residual classes, enumerated on assertScopeMarkers. Each puts the marker
// in a real WHERE clause and still enforces nothing; each is ACCEPTED today.
// Asserting the acceptance keeps the gap a recorded property of the seam — and
// means anyone who calls this guard the mandate has to delete a passing test.
describe("assertScopeMarkers — KNOWN-ACCEPTED queries that enforce nothing", () => {
  const labelScope: GraphScope = { labels: ["Doc"] };
  const known: Array<[name: string, cypher: string]> = [
    [
      "1. negated — selects exactly the labels the mandate excludes",
      `MATCH (n) WHERE NOT (n.label IN $${SCOPE_LABELS_PARAM}) RETURN n`,
    ],
    [
      "2. disjoined — a row passes without the membership holding",
      `MATCH (n) WHERE n.x = 1 OR n.label IN $${SCOPE_LABELS_PARAM} RETURN n`,
    ],
    [
      "3. compared — the boolean is an operand, not the gate",
      `MATCH (n) WHERE n.allowed = (n.label IN $${SCOPE_LABELS_PARAM}) RETURN n`,
    ],
    [
      "4. argument — coalesce discards a false",
      `MATCH (n) WHERE coalesce(n.label IN $${SCOPE_LABELS_PARAM}, true) RETURN n`,
    ],
    [
      "5. binder, not membership — the same IN token, a different operator",
      `MATCH (n) WHERE size([x IN $${SCOPE_LABELS_PARAM} | x]) >= 0 RETURN n`,
    ],
    [
      "6. wrong variable — a real gate, on rows the query does not return",
      `MATCH (a) MATCH (b) WHERE any(l IN labels(a) WHERE l IN $${SCOPE_LABELS_PARAM}) RETURN b`,
    ],
    [
      "7. wrong branch — the predicate guards one UNION branch only",
      `MATCH (a) WHERE any(l IN labels(a) WHERE l IN $${SCOPE_LABELS_PARAM}) RETURN a
       UNION MATCH (b) RETURN b`,
    ],
  ];

  for (const [name, cypher] of known) {
    it(`accepts, and should not be read as enforcement: ${name}`, () => {
      expect(() => assertScopeMarkers(cypher, labelScope)).not.toThrow();
    });
  }

  it("does not bound writes: extend mode may still create an out-of-scope label", () => {
    // The allow-list is a READ filter. Nothing in this seam reads the label
    // literals a write pattern applies, so a marker in a real WHERE buys a
    // MERGE of any label at all. Decidable, but a different control.
    expect(() =>
      applyGraphScope(
        `MATCH (a) WHERE any(l IN labels(a) WHERE l IN $${SCOPE_LABELS_PARAM})
         MERGE (n:Forbidden {orgId: $orgId}) RETURN n LIMIT 1`,
        {},
        { labels: ["Doc"], mode: "extend" },
      ),
    ).not.toThrow();
  });
});

// ── Expression-subquery clause state ─────────────────────────────────────────
//
// A brace is the one delimiter in Cypher that can carry a WHOLE CLAUSE SEQUENCE
// without opening a paren or a bracket. `clause` was a single global, so the
// `WHERE` inside `EXISTS { MATCH (m) WHERE m.x = 1 }` survived the closing brace
// and governed the enclosing projection: everything after it was kept as if it
// were a predicate, and an ALIASED COLUMN — which filters nothing — was handed
// to both guards as a real anchor.
describe("an inner clause does not govern the enclosing expression", () => {
  const labelScope: GraphScope = { labels: ["Doc"] };

  it("a WHERE inside EXISTS { … } does not make the rest of a RETURN a predicate", () => {
    // Review's query, verbatim. `n` is completely unscoped; the only mention of
    // the marker-parameter shape is an alias in the projection.
    const cypher =
      "MATCH (n) RETURN EXISTS { MATCH (m) WHERE m.x = 1 } AS ok, n.orgId = $orgId AS mine, n";
    const kept = keepFilteringPositions(cypher);
    expect(kept).not.toContain("$orgId");
    expect(kept).not.toContain("mine");
    // The subquery's own WHERE is still a real one and still survives.
    expect(kept).toContain("m.x = 1");
  });

  it("the same leak for the scope marker is rejected", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) RETURN EXISTS { MATCH (m) WHERE m.x = 1 } AS ok, n.label IN $${SCOPE_LABELS_PARAM} AS allowed, n`,
        labelScope,
      ),
    ).toThrow(GraphScopeError);
  });

  it("COUNT { … } leaks no differently from EXISTS { … }", () => {
    const kept = keepFilteringPositions(
      "MATCH (n) RETURN COUNT { MATCH (m) WHERE m.x = 1 } AS c, n.orgId = $orgId AS mine, n",
    );
    expect(kept).not.toContain("$orgId");
  });

  it("a CALL subquery reverts to the enclosing clause, not the subquery's last one", () => {
    // NOT a discriminating case, and labelled so rather than left to look like
    // one: a CALL subquery must end in RETURN, so `clause` left the brace as
    // RETURN even before the restore and the outer projection was blanked
    // either way. It pins the restore path for the shape that will keep being
    // written, next to the EXISTS cases above that DO discriminate.
    const kept = keepFilteringPositions(
      "CALL { MATCH (x) WHERE x.y = 1 RETURN x } RETURN x, x.orgId = $orgId AS mine",
    );
    expect(kept).not.toContain("$orgId");
    expect(kept).toContain("x.y = 1");
  });

  // Discriminating negatives: a guard that gets stricter must not start
  // refusing correctly-scoped queries that happen to contain an expression
  // subquery. All four of these anchor properly and must still pass.
  const stillAccepted: Array<[name: string, cypher: string]> = [
    [
      "anchored in a pattern map, with EXISTS { … WHERE … } in the WHERE",
      "MATCH (n {orgId: $orgId}) WHERE EXISTS { MATCH (m) WHERE m.x = 1 } RETURN n",
    ],
    [
      "anchored in the same WHERE, after the subquery",
      "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.x = 1 } AND n.orgId = $orgId RETURN n",
    ],
    [
      "anchored in the same WHERE, before the subquery",
      "MATCH (n) WHERE n.orgId = $orgId AND EXISTS { MATCH (m) WHERE m.x = 1 } RETURN n",
    ],
    [
      "anchored inside a CALL subquery",
      "CALL { MATCH (n) WHERE n.orgId = $orgId RETURN n } RETURN n",
    ],
  ];
  for (const [name, cypher] of stillAccepted) {
    it(`still accepts a correctly-scoped query: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).toContain("$orgId");
    });
  }

  it("still accepts a scope marker in a WHERE alongside EXISTS { … WHERE … }", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.x = 1 } AND n.label IN $${SCOPE_LABELS_PARAM} RETURN n`,
        labelScope,
      ),
    ).not.toThrow();
  });
});

// ── A map literal is a value, not a filter ───────────────────────────────────
//
// A `WHERE` clause is kept whole, so a map literal written inside one handed the
// tenancy guard its key. `MATCH (n) WHERE {orgId: $orgId} IS NOT NULL RETURN n`
// is an always-true predicate over every tenant's nodes, and `orgId: $orgId`
// sitting in a kept `WHERE` satisfied the guard.
//
// The cases below are an ENUMERATION of the positions a map can occupy, not the
// one encoding review demonstrated. Review reported the first; the other ten
// came from listing where `orgId` and `$orgId` can sit adjacent without
// constraining the matched variable, and every one of them was accepted.
describe("a map literal in a filtering position is not a tenant anchor", () => {
  const labelScope: GraphScope = { labels: ["Doc"] };
  const encodings: Array<[name: string, cypher: string]> = [
    [
      "bare in a WHERE (review's case)",
      "MATCH (n) WHERE {orgId: $orgId} IS NOT NULL RETURN n",
    ],
    ["parenthesised", "MATCH (n) WHERE ({orgId: $orgId}) IS NOT NULL RETURN n"],
    [
      "as a function argument",
      "MATCH (n) WHERE size(keys({orgId: $orgId})) > 0 RETURN n",
    ],
    [
      "inside a list literal",
      "MATCH (n) WHERE [{orgId: $orgId}] IS NOT NULL RETURN n",
    ],
    [
      "produced by a list comprehension",
      "MATCH (n) WHERE [x IN [1] | {orgId: $orgId}] IS NOT NULL RETURN n",
    ],
    [
      "compared against a property",
      "MATCH (n) WHERE n.meta = {orgId: $orgId} RETURN n",
    ],
    [
      "as a map PROJECTION",
      "MATCH (n) WHERE n{orgId: $orgId} IS NOT NULL RETURN n",
    ],
    [
      "inside a CASE expression",
      "MATCH (n) WHERE CASE WHEN true THEN {orgId: $orgId} ELSE null END IS NOT NULL RETURN n",
    ],
    [
      "inside a subquery's own WHERE",
      "MATCH (n) WHERE EXISTS { MATCH (m) WHERE {orgId: $orgId} IS NOT NULL } RETURN n",
    ],
    [
      "holding the whole comparison as a VALUE",
      "MATCH (n) WHERE {k: n.orgId = $orgId} IS NOT NULL RETURN n",
    ],
    [
      "nested one level inside a genuine pattern map",
      "MATCH (n {meta: {orgId: $orgId}}) RETURN n",
    ],
  ];

  for (const [name, cypher] of encodings) {
    it(`is not an anchor: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    });
  }

  it("the scope marker has the identical hole, and it closes the same way", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE {allowed: n.label IN $${SCOPE_LABELS_PARAM}} IS NOT NULL RETURN n`,
        labelScope,
      ),
    ).toThrow(GraphScopeError);
  });

  // The three brace meanings, each asserted on a query that must still pass.
  // `{orgId: $orgId}` and `(n {orgId: $orgId})` differ only in what ENCLOSES the
  // brace, so getting stricter about one must not refuse the other.
  const stillAccepted: Array<[name: string, cypher: string]> = [
    ["a node pattern property map", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "a relationship pattern property map",
      "MATCH (a)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    [
      "a pattern map inside an EXISTS subquery",
      "MATCH (n) WHERE EXISTS { MATCH (m {orgId: $orgId}) } RETURN n",
    ],
    [
      "a property predicate in a WHERE",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "a property predicate parenthesised in a WHERE",
      "MATCH (n) WHERE (n.orgId = $orgId) RETURN n",
    ],
    [
      "a property predicate inside a CALL subquery",
      "CALL { MATCH (n) WHERE n.orgId = $orgId RETURN n } RETURN n",
    ],
    [
      "a property predicate inside a SCOPED CALL subquery",
      "MATCH (n) CALL (n) { MATCH (m) WHERE m.orgId = $orgId RETURN m } RETURN m",
    ],
    [
      "a property predicate beside an EXISTS subquery",
      "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.x = 1 } AND n.orgId = $orgId RETURN n",
    ],
  ];
  for (const [name, cypher] of stillAccepted) {
    it(`still anchors: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).toContain("$orgId");
    });
  }

  // The blanking is scoped to the BRACES, not to the clause. An implementation
  // that refused a WHERE containing any map literal would be simpler and would
  // break every query that carries both — so both orders are pinned.
  it("a map literal does not blank the rest of its own WHERE clause", () => {
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE {a: 1} IS NOT NULL AND n.orgId = $orgId RETURN n",
      ),
    ).toContain("$orgId");
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE n.orgId = $orgId AND {a: 1} IS NOT NULL RETURN n",
      ),
    ).toContain("$orgId");
  });

  it("a GQL quantified path pattern's {n,m} does not swallow the query", () => {
    // `((a)-[:R]->(b)){1,5}` puts a brace where neither a pattern map nor a
    // subquery can appear. It classifies as a map literal, which is harmless —
    // the assertion is that the clause state and the map depth both come back
    // balanced, so the anchor after it still counts.
    expect(
      keepFilteringPositions(
        "MATCH ((a)-[:R]->(b)){1,5} WHERE a.orgId = $orgId RETURN b",
      ),
    ).toContain("$orgId");
  });

  it("an unbalanced closing brace does not desync the scan", () => {
    expect(
      keepFilteringPositions("MATCH (n) WHERE n.orgId = $orgId RETURN n }"),
    ).toContain("$orgId");
  });

  it("a COUNT subquery is a subquery brace, not a map", () => {
    // Discriminates the "subquery" classification from "map": if COUNT were
    // read as a map literal its whole body would be blanked, including a real
    // inner WHERE.
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE COUNT { MATCH (m) WHERE m.orgId = $orgId } > 0 RETURN n",
      ),
    ).toContain("$orgId");
  });
});

// ── Which classifier is asked first ─────────────────────────────────────────
//
// Two brace classifiers can both be true at the same `{`, and the ORDER they are
// consulted in is a decision in its own right — a fifth thing this scanner
// decides, separate from the four questions it answers.
//
// `opensPatternMap` used to be asked first. Cypher 5's inline node predicate
// then defeated it: the node paren is a pattern, so a `COLLECT { … }` sitting
// inside it was classified as the pattern's property map, and the WHOLE
// subquery — projections included — was kept as a filtering position.
//
//   MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> [])
//
// `COLLECT` is non-empty whenever any node exists, so the predicate is true for
// every row, and the projected comparison supplied the anchor.
//
// Review reported `COLLECT` in an inline NODE predicate. Seven shapes did it.
describe("a subquery is classified before a pattern property map", () => {
  const labelScope: GraphScope = { labels: ["Doc"] };
  const bypasses: Array<[name: string, cypher: string]> = [
    [
      "COLLECT in an inline node predicate (review's case)",
      "MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> []) RETURN n",
    ],
    [
      "EXISTS in an inline node predicate",
      "MATCH (n WHERE EXISTS { MATCH (m) RETURN m.orgId = $orgId AS mine }) RETURN n",
    ],
    [
      "COUNT in an inline node predicate",
      "MATCH (n WHERE COUNT { MATCH (m) RETURN m.orgId = $orgId AS mine } > 0) RETURN n",
    ],
    [
      "COLLECT in an inline RELATIONSHIP predicate",
      "MATCH (a)-[r WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> []]->(b) RETURN a",
    ],
    [
      "COUNT in an inline relationship predicate",
      "MATCH (a)-[r WHERE COUNT { MATCH (m) RETURN m.orgId = $orgId AS mine } > 0]->(b) RETURN a",
    ],
    [
      "a subquery nested inside another, both inline",
      "MATCH (n WHERE EXISTS { MATCH (x WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS q } <> []) }) RETURN n",
    ],
    [
      "the same shape under MERGE",
      "MERGE (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS q } <> []) RETURN n",
    ],
  ];

  for (const [name, cypher] of bypasses) {
    it(`does not keep the subquery as a property map: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    });
  }

  it("the SCOPE guard was already immune, by round eight's policy split", () => {
    // `keepPredicatePositions` drops the pattern-map position entirely, so the
    // mis-classification could never reach the marker guard. Asserted so the
    // asymmetry is a recorded property rather than a coincidence someone later
    // "tidies" by re-unifying the two projections.
    expect(() =>
      assertScopeMarkers(
        `MATCH (n WHERE COLLECT { MATCH (m) RETURN m.label IN $${SCOPE_LABELS_PARAM} AS ok } <> []) RETURN n`,
        labelScope,
      ),
    ).toThrow(GraphScopeError);
  });

  // Swapping the two cannot cost a genuine pattern map, and that is a property
  // of the grammar rather than a hope: a property map is never preceded by
  // CALL / EXISTS / COUNT / COLLECT, so `opensSubquery` is false at every brace
  // `opensPatternMap` is meant to claim. These pin it.
  const stillAnchors: Array<[name: string, cypher: string]> = [
    ["a node pattern property map", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "a relationship pattern property map",
      "MATCH (a)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    [
      "a pattern map INSIDE an inline-predicate subquery",
      "MATCH (n WHERE EXISTS { MATCH (m {orgId: $orgId}) }) RETURN n",
    ],
    [
      "a pattern map inside a top-level EXISTS",
      "MATCH (n) WHERE EXISTS { MATCH (m {orgId: $orgId}) } RETURN n",
    ],
    [
      "a pattern map beside an inline predicate on the same node",
      "MATCH (n {orgId: $orgId} WHERE n.x > 1) RETURN n",
    ],
    [
      "a property predicate in a WHERE",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "an anchor inside a CALL subquery",
      "CALL { MATCH (n) WHERE n.orgId = $orgId RETURN n } RETURN n",
    ],
    [
      "a COUNT subquery at top level, anchored in its WHERE",
      "MATCH (n) WHERE COUNT { MATCH (m) WHERE m.orgId = $orgId } > 0 RETURN n",
    ],
  ];
  for (const [name, cypher] of stillAnchors) {
    it(`still anchors: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).toContain("$orgId");
    });
  }

  // ROUND 12 RECORDED A COST HERE. ROUND 14 REMOVED IT, AND THE REMOVAL IS THE
  // POINT — the cost and a cross-tenant read were the same mechanism.
  //
  // Round 12 wrote: clause keywords are recognised only at paren/bracket depth
  // 0, so inside an inline node predicate a subquery's own `WHERE` never becomes
  // the clause, and an anchor written only there is refused. True, fail-closed,
  // and it declined to fix it because recognising clauses inside a paren-nested
  // brace "would OPEN kept regions".
  //
  // It opens exactly one: the subquery's own clause sequence, which is where a
  // `WHERE` genuinely filters. What it CLOSES is that with recognition off, the
  // outer `WHERE` stayed in force over the subquery's whole body — so a
  // projection, and even a `SET`, was read as a predicate. See
  // `describe("a subquery's clause baseline is its own")`. Recognition narrows;
  // it does not widen. Both spellings now anchor, and agreeing is the property.
  it("anchors in an inline-predicate subquery's WHERE, as at top level", () => {
    expect(
      keepFilteringPositions(
        "MATCH (n WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId }) RETURN n",
      ),
    ).toContain("$orgId");
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId } RETURN n",
      ),
    ).toContain("$orgId");
    // …and the projection spelling of the same query is still refused, which is
    // what stops this from being a widening.
    expect(
      keepFilteringPositions(
        "MATCH (n WHERE EXISTS { MATCH (m) RETURN m.orgId = $orgId AS x }) RETURN n",
      ),
    ).not.toContain("$orgId");
  });
});

// ── The precedence relations, enumerated ────────────────────────────────────
//
// Round twelve's finding was not that a rule is wrong — both brace classifiers
// are individually correct. It was that the ORDER they are consulted in is
// itself a decision, and that decision had never been enumerated. So here it is:
// every pair of tests in this module that can both match at one position, which
// is asked first, and the query that tells the two orders apart.
//
// Several of these are pinned in their own describe blocks above and are
// repeated here only so the ORDER is checkable in one place.
describe("classifier precedence is decided, not incidental", () => {
  const relations: Array<
    [id: string, relation: string, cypher: string, anchors: boolean]
  > = [
    [
      "P1",
      "opensSubquery before opensPatternMap — direct token beats enclosing bracket",
      "MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> []) RETURN n",
      false,
    ],
    [
      "P2",
      "opensPatternMap before the 'map' default — a real pattern map still wins",
      "MATCH (n {orgId: $orgId}) RETURN n",
      true,
    ],
    [
      "P3",
      "the clause gate before the preceding character, inside opensPattern",
      "MATCH (n) WHERE true = ({orgId: $orgId} IS NOT NULL) RETURN n",
      false,
    ],
    [
      "P4",
      "the clause gate before the `-[` relationship test",
      "MATCH (n) WHERE n.x - [{orgId: $orgId}] IS NOT NULL RETURN n",
      false,
    ],
    [
      "P5",
      "the per-subquery clause baseline before the outer clause — round 14",
      "MATCH (n WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId }) RETURN n",
      true,
    ],
    [
      "P6",
      "…and the same shape at depth 0, which always agreed",
      "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId } RETURN n",
      true,
    ],
    [
      "P7",
      "inMapLiteral before both arms of keeping()",
      "MATCH (n) WHERE {x: COUNT { MATCH (m) WHERE m.orgId = $orgId }} IS NOT NULL RETURN n",
      false,
    ],
    [
      "P8",
      "…a subquery not inside a map literal is unaffected",
      "MATCH (n) WHERE COUNT { MATCH (m) WHERE m.orgId = $orgId } > 0 RETURN n",
      true,
    ],
    [
      "P9",
      "the position filter before the anchor shape",
      "MATCH (n) SET n.orgId = $orgId RETURN n",
      false,
    ],
    [
      "P10",
      "brace-kind pop and clause restore before keeping()",
      "MATCH (n) RETURN EXISTS { MATCH (m) WHERE m.x = 1 } AS ok, n.orgId = $orgId AS mine, n",
      false,
    ],
    [
      "P11",
      "…and the map depth unwinds, so a map does not blank its own clause",
      "MATCH (n) WHERE {a: 1} IS NOT NULL AND n.orgId = $orgId RETURN n",
      true,
    ],
  ];

  for (const [id, relation, cypher, anchors] of relations) {
    it(`${id}: ${relation}`, () => {
      const kept = keepFilteringPositions(cypher);
      if (anchors) expect(kept).toContain("$orgId");
      else expect(kept).not.toContain("$orgId");
    });
  }
});

// ── A grouping bracket is not a pattern bracket ──────────────────────────────
//
// `opensPattern` decided pattern-ness from the single character before the
// bracket. That set is `,`, `-`, `>`, `<`, `=`, `|`, `(`, `[` — and every one of
// them is ordinary EXPRESSION syntax as well as pattern syntax, so outside a
// graph-pattern clause each one classified grouping as a node pattern. The brace
// inside then became a pattern property map instead of a map literal, `mapDepth`
// never rose, and round ten's fix was bypassed:
//
//     MATCH (n) WHERE true = ({orgId: $orgId} IS NOT NULL) RETURN n
//
// Review reported the `=` spelling. All eight characters do it, and they are
// enumerated here rather than left for round twelve.
describe("a grouping bracket in an expression is not a pattern bracket", () => {
  const labelScope: GraphScope = { labels: ["Doc"] };
  const grouped: Array<[name: string, cypher: string]> = [
    [
      "after `=` (review's case)",
      "MATCH (n) WHERE true = ({orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "after `,` in a function call",
      "MATCH (n) WHERE coalesce(1, ({orgId: $orgId} IS NOT NULL)) RETURN n",
    ],
    [
      "after `(` — grouping inside grouping",
      "MATCH (n) WHERE ((({orgId: $orgId} IS NOT NULL))) RETURN n",
    ],
    [
      "after `>`",
      "MATCH (n) WHERE 1 > 0 AND true = ({orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "after `<>`",
      "MATCH (n) WHERE true <> ({orgId: $orgId} IS NULL) RETURN n",
    ],
    [
      "after `|` in a list comprehension",
      "MATCH (n) WHERE [x IN [1] | ({orgId: $orgId})] IS NOT NULL RETURN n",
    ],
    [
      "after `[` — a list of groups",
      "MATCH (n) WHERE [({orgId: $orgId})] IS NOT NULL RETURN n",
    ],
    [
      "after `-` — a bracket that is not a relationship",
      "MATCH (n) WHERE n.x - [{orgId: $orgId}] IS NOT NULL RETURN n",
    ],
  ];

  for (const [name, cypher] of grouped) {
    it(`does not make the enclosed brace a pattern map: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    });
  }

  it("the scope marker has the same hole through a grouped map", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE true = ({allowed: n.label IN $${SCOPE_LABELS_PARAM}} IS NOT NULL) RETURN n`,
        labelScope,
      ),
    ).toThrow(GraphScopeError);
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE coalesce(1, ({allowed: n.label IN $${SCOPE_LABELS_PARAM}})) RETURN n`,
        labelScope,
      ),
    ).toThrow(GraphScopeError);
  });

  // The false-reject direction. Every one of the eight characters above is also
  // REAL pattern syntax inside a graph-pattern clause, and all of those must
  // keep anchoring — otherwise the fix trades a bypass for an outage.
  const stillPatterns: Array<[name: string, cypher: string]> = [
    ["a plain node pattern map", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "after `,` — comma-separated patterns",
      "MATCH (a), (b {orgId: $orgId}) RETURN a",
    ],
    [
      "after `=` — a named path",
      "MATCH p = (a {orgId: $orgId})-[:R]->(b) RETURN p",
    ],
    [
      "after `-` — a relationship pattern map",
      "MATCH (a)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    [
      "under OPTIONAL MATCH",
      "MATCH (x {orgId: $orgId}) OPTIONAL MATCH (y {orgId: $orgId}) RETURN y",
    ],
    ["under MERGE as the first clause", "MERGE (n {orgId: $orgId}) RETURN n"],
    [
      "inside an EXISTS subquery's MATCH",
      "MATCH (n) WHERE EXISTS { MATCH (m {orgId: $orgId}) } RETURN n",
    ],
    [
      "a grouped expression earlier in the query",
      "MATCH (a) WHERE true = (1 = 1) MATCH (b {orgId: $orgId}) RETURN b",
    ],
  ];
  for (const [name, cypher] of stillPatterns) {
    it(`still reads as a pattern: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).toContain("$orgId");
    });
  }

  it("a grouped expression does not desync the bracket stack", () => {
    // The grouping paren is pushed as a non-pattern frame and popped again, so
    // a pattern AFTER it is classified on its own merits.
    const kept = keepFilteringPositions(
      "MATCH (a) WHERE true = ((1 = 1)) AND a.orgId = $orgId RETURN a",
    );
    expect(kept).toContain("$orgId");
  });
});

// ── Unicode identifier delimiting ────────────────────────────────────────────
//
// Cypher spells an unescaped symbolic name with Unicode rules (openCypher:
// IdentifierPart = ID_Continue | Sc); JavaScript's `\b`, `\w` and
// `[A-Za-z0-9_]` are ASCII-only. Every place this module drew a token boundary
// with the ASCII form drew it in the wrong place for a name with one accent in
// it — and an accented name is an ORDINARY name, which is what makes this
// reachable where the reserved-word argument said it was not.
describe("token boundaries follow Cypher's Unicode identifier rules", () => {
  const labelScope: GraphScope = { labels: ["Doc"] };

  it("a non-ASCII suffix names a DIFFERENT, caller-supplied parameter", () => {
    // `assertNoReservedParamCollision` reserves the exact name only, so a
    // caller may pass `__scopeLabelsé` and choose its contents. Under an ASCII
    // `\b` the marker regex could not tell it from the seam's own parameter.
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE n.label IN $${SCOPE_LABELS_PARAM}é RETURN n`,
        labelScope,
      ),
    ).toThrow(GraphScopeError);
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE type(r) IN $${SCOPE_REL_TYPES_PARAM}é RETURN n`,
        { relationshipTypes: ["REL"] },
      ),
    ).toThrow(GraphScopeError);
  });

  // A name spelled like a clause keyword plus one more identifier character.
  // `RETURN n AS where` is rejected by Cypher (reserved word), which is why the
  // bare-alias class was documented as unreachable. `whereé` is NOT reserved,
  // the database takes it, and an ASCII word scan handed the seam the keyword
  // `WHERE` with the tail left behind — manufacturing a predicate region over a
  // projection, which is what the reserved-word argument said could not happen.
  // The `$` case is why `\p{Sc}` is in the identifier-part class: `$` continues
  // a Cypher identifier, so `where$` is one name too.
  const keywordLookalikes: Array<[name: string, alias: string]> = [
    ["a combining accent after the keyword", "wheré"],
    ["a precomposed letter after the keyword", "whereé"],
    ["a currency symbol after the keyword", "where$"],
  ];
  for (const [name, alias] of keywordLookalikes) {
    it(`is one identifier, not a clause: ${name} (${alias})`, () => {
      expect(
        keepFilteringPositions(
          `MATCH (n) RETURN n AS ${alias}, n.orgId = $orgId AS mine`,
        ),
      ).not.toContain("$orgId");
      expect(() =>
        assertScopeMarkers(
          `MATCH (n) RETURN n AS ${alias}, n.label IN $${SCOPE_LABELS_PARAM} AS ok`,
          labelScope,
        ),
      ).toThrow(GraphScopeError);
    });
  }

  // Outside the BMP, and the reason this is a THIRD encoding of the same defect
  // rather than a fourth case of the second. `where\u{1D431}` and
  // `\u{1D431}where` are each one Cypher identifier (U+1D431 is ID_Start and
  // ID_Continue), but a JavaScript string index yields one UTF-16 unit, so a
  // per-character scan sees a lone surrogate, matches no Unicode property, and
  // splits the name — handing the seam the bare keyword `WHERE` out of both.
  // Fixing the character CLASSES did not fix this; matching the whole name with
  // the `u` flag did.
  const astralLookalikes: Array<[name: string, alias: string]> = [
    ["an astral letter after the keyword", "where\u{1D431}"],
    ["an astral letter before the keyword", "\u{1D431}where"],
  ];
  for (const [name, alias] of astralLookalikes) {
    it(`is one identifier, not a clause: ${name} (${alias})`, () => {
      expect(
        keepFilteringPositions(
          `MATCH (n) RETURN n AS ${alias}, n.orgId = $orgId AS mine`,
        ),
      ).not.toContain("$orgId");
      expect(() =>
        assertScopeMarkers(
          `MATCH (n) RETURN n AS ${alias}, n.label IN $${SCOPE_LABELS_PARAM} AS ok`,
          labelScope,
        ),
      ).toThrow(GraphScopeError);
    });
  }

  it("a real clause keyword is still recognised, and a real marker still passes", () => {
    expect(
      keepFilteringPositions("MATCH (n) WHERE n.orgId = $orgId RETURN n"),
    ).toContain("$orgId");
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) WHERE n.label IN $${SCOPE_LABELS_PARAM} RETURN n`,
        labelScope,
      ),
    ).not.toThrow();
  });

  it("a legitimately non-ASCII variable elsewhere in the query is untouched", () => {
    // Getting stricter must not mean refusing valid Cypher. The marker here is
    // correct; the query merely also mentions an accented identifier.
    expect(() =>
      assertScopeMarkers(
        `MATCH (nøde) WHERE nøde.label IN $${SCOPE_LABELS_PARAM} RETURN nøde`,
        labelScope,
      ),
    ).not.toThrow();
    expect(
      keepFilteringPositions(
        "MATCH (nøde) WHERE nøde.orgId = $orgId RETURN nøde",
      ),
    ).toContain("$orgId");
  });

  it("a parameterized LIMIT fails closed whatever the parameter is named", () => {
    // `\$\w+` is ASCII-only, so `LIMIT $é` evaded the fail-closed check AND
    // the literal rewrite, and the seam appended a second LIMIT — a syntax
    // error at the database instead of the error the author needs to read.
    expect(() => clampLimits("MATCH (n) RETURN n LIMIT $n", 50)).toThrow(
      GraphScopeError,
    );
    expect(() => clampLimits("MATCH (n) RETURN n LIMIT $é", 50)).toThrow(
      GraphScopeError,
    );
  });
});

// ── Clause keywords are recognised only at clause boundaries ────────────────
//
// The scanner recognised a keyword by nesting depth alone, so a caller-
// controlled name spelled like one moved the clause state. Both guards read the
// same clause state, so the spoof reached both: for tenancy it opened a kept
// region over a SET target (a tenant-wide write bypass, asserted end to end in
// tenant.scope-guard.test.ts); here it manufactures a "WHERE" for a marker that
// is nowhere near one.
describe("clause keywords are recognised only at clause boundaries", () => {
  const labelScope: GraphScope = { labels: ["Doc"] };

  it("a spoofed clause does not put a scope marker in a predicate position", () => {
    expect(() =>
      assertScopeMarkers(
        `MATCH (n) SET n.x = $where, n.ok = n.label IN $${SCOPE_LABELS_PARAM} RETURN n`,
        labelScope,
      ),
    ).toThrow(GraphScopeError);
  });

  const disqualified: Array<[name: string, cypher: string]> = [
    ["$ — a parameter name", "MATCH (n) SET n.x = $where, n.orgId = $orgId"],
    ["· — a property key", "MATCH (n) SET n.where = 1, n.orgId = $orgId"],
    [": — a label", "MATCH (n) SET n:Where, n.orgId = $orgId"],
    ["trailing : — a map key", "MATCH (n) SET n += {where: 1, orgId: $orgId}"],
  ];

  for (const [name, cypher] of disqualified) {
    it(`keeps nothing when the clause is spoofed by ${name}`, () => {
      // Every character is blanked: no clause ever opened a keeping region.
      expect(keepFilteringPositions(cypher).trim()).toBe("");
      expect(keepPredicatePositions(cypher).trim()).toBe("");
    });
  }

  it("leaves the clause alone rather than clearing it", () => {
    // A disqualified word is an ordinary identifier, so the WHERE it sits
    // inside continues. Clearing the clause instead would be the mirror defect.
    const kept = keepFilteringPositions(
      "MATCH (n) WHERE n.set = 1 AND n.orgId = $orgId RETURN n",
    );
    expect(kept).toContain("n.orgId = $orgId");
    expect(kept).not.toContain("RETURN");
  });

  it("still recognises a real clause after an identifier token", () => {
    // The finding's phrasing would also disqualify a keyword preceded by an
    // identifier. Measured against the tree, that rejects 4 of the 63 corpus
    // queries and 1 of the 4 marker sites — every `YIELD node AS n, score
    // WHERE …` shape — so the rule stops at tokens that can only introduce an
    // identifier: `$`, `.`, `:` before, and `:` after.
    const kept = keepFilteringPositions(
      "CALL db.index.vector.queryNodes('i', $k, $v) YIELD node AS n, score WHERE n.orgId = $orgId RETURN n",
    );
    expect(kept).toContain("n.orgId = $orgId");
  });

  it("still recognises a CALL subquery's inner clauses", () => {
    const kept = keepFilteringPositions(
      "MATCH (a) CALL { WITH a MATCH (b) WHERE b.orgId = $orgId RETURN b } RETURN b",
    );
    expect(kept).toContain("b.orgId = $orgId");
  });
});

describe("assertNoReservedParamCollision", () => {
  it("passes clean params", () => {
    expect(() => assertNoReservedParamCollision({ foo: 1 })).not.toThrow();
  });

  it.each([SCOPE_LABELS_PARAM, SCOPE_REL_TYPES_PARAM])(
    "throws when caller supplies reserved %s",
    (key) => {
      expect(() => assertNoReservedParamCollision({ [key]: ["x"] })).toThrow(
        GraphScopeError,
      );
    },
  );
});

describe("buildScopeParams", () => {
  it("injects only the constrained dimensions", () => {
    expect(buildScopeParams({ labels: ["Doc"] })).toEqual({
      [SCOPE_LABELS_PARAM]: ["Doc"],
    });
    expect(
      buildScopeParams({ labels: ["Doc"], relationshipTypes: ["R"] }),
    ).toEqual({
      [SCOPE_LABELS_PARAM]: ["Doc"],
      [SCOPE_REL_TYPES_PARAM]: ["R"],
    });
    expect(buildScopeParams({})).toEqual({});
  });
});

describe("clampVarLengthHops", () => {
  it.each([
    ["MATCH (a)-[*]->(b)", 3, "MATCH (a)-[*1..3]->(b)"],
    ["MATCH (a)-[*..5]->(b)", 3, "MATCH (a)-[*1..3]->(b)"],
    ["MATCH (a)-[*2..]->(b)", 5, "MATCH (a)-[*2..5]->(b)"],
    ["MATCH (a)-[*1..5]->(b)", 3, "MATCH (a)-[*1..3]->(b)"],
    ["MATCH (a)-[r:KNOWS*1..5]->(b)", 2, "MATCH (a)-[r:KNOWS*1..2]->(b)"],
    ["MATCH (a)-[:REL*3]->(b)", 2, "MATCH (a)-[:REL*2]->(b)"],
  ])("clamps %s at maxHops=%i", (input, maxHops, expected) => {
    expect(clampVarLengthHops(input, maxHops)).toBe(expected);
  });

  it("preserves a bound already within budget", () => {
    expect(clampVarLengthHops("MATCH (a)-[*1..2]->(b)", 5)).toBe(
      "MATCH (a)-[*1..2]->(b)",
    );
  });

  it("leaves a fixed-length relationship untouched", () => {
    expect(clampVarLengthHops("MATCH (a)-[r:KNOWS]->(b)", 3)).toBe(
      "MATCH (a)-[r:KNOWS]->(b)",
    );
  });

  it("is a no-op for a negative budget", () => {
    expect(clampVarLengthHops("MATCH (a)-[*]->(b)", -1)).toBe(
      "MATCH (a)-[*]->(b)",
    );
  });
});

describe("clampLimits", () => {
  it.each([
    "MATCH (a) RETURN a LIMIT 10 UNION MATCH (b) RETURN b",
    "MATCH (a) RETURN a UNION MATCH (b) RETURN b LIMIT 10",
    "MATCH (a) WITH a LIMIT 10 RETURN a UNION MATCH (b) RETURN b LIMIT 10",
    "MATCH (a) RETURN a, 'LIMIT 10' UNION MATCH (b) RETURN b LIMIT 10",
    "CALL { MATCH (a) RETURN a LIMIT 10 UNION MATCH (b) RETURN b } RETURN a LIMIT 10",
  ])("rejects an unlimited UNION branch: %s", (query) => {
    expect(() => clampLimits(query, 100)).toThrow(/UNION/);
  });

  it.each([
    "éUNION",
    "UNIONé",
    "RETURNé",
    "éRETURN",
    "LIMITé",
    "éLIMIT",
    "𝐱UNION",
  ])("keeps Unicode aliases intact: %s", (alias) => {
    const query = `MATCH (n) RETURN n AS ${alias} LIMIT 10 UNION MATCH (m) RETURN m AS ${alias} LIMIT 10`;
    expect(clampLimits(query, 100)).toBe(query);
    expect(() => clampLimits(query.replace(/ LIMIT 10$/, ""), 100)).toThrow(
      /UNION/,
    );
  });

  it("does not let a property named RETURN hide a bounded branch", () => {
    const query =
      "MATCH (n) RETURN n . RETURN LIMIT 10 UNION MATCH (m) RETURN m . RETURN LIMIT 10";
    expect(clampLimits(query, 100)).toBe(query);
  });

  it("rejects unbalanced query scopes", () => {
    expect(() => clampLimits("CALL { RETURN 1 LIMIT 10", 100)).toThrow(
      /braces/,
    );
  });

  it("does not treat map keys, properties, or escaped names as UNION branches", () => {
    const query =
      "MATCH (n) RETURN {union: 1, return: 2}, n.union, n.`UNION` LIMIT 1000";
    expect(clampLimits(query, 100)).toBe(
      query.replace("LIMIT 1000", "LIMIT 100"),
    );
  });

  it("clamps a larger literal LIMIT down", () => {
    expect(clampLimits("MATCH (n) RETURN n LIMIT 1000", 100)).toBe(
      "MATCH (n) RETURN n LIMIT 100",
    );
  });

  it("preserves a smaller literal LIMIT", () => {
    expect(clampLimits("MATCH (n) RETURN n LIMIT 10", 100)).toBe(
      "MATCH (n) RETURN n LIMIT 10",
    );
  });

  it("appends a LIMIT when none is present", () => {
    expect(clampLimits("MATCH (n) RETURN n", 50)).toBe(
      "MATCH (n) RETURN n\nLIMIT 50",
    );
  });

  it("clamps every literal LIMIT across a WITH chain", () => {
    const out = clampLimits(
      "MATCH (n) WITH n ORDER BY n.x LIMIT 500 RETURN n LIMIT 900",
      100,
    );
    expect(out).toBe(
      "MATCH (n) WITH n ORDER BY n.x LIMIT 100 RETURN n LIMIT 100",
    );
  });

  it("clamps each branch of a UNION with per-branch LIMITs", () => {
    const out = clampLimits(
      "MATCH (a) RETURN a LIMIT 1000 UNION MATCH (b) RETURN b LIMIT 2000",
      100,
    );
    expect(out).toBe(
      "MATCH (a) RETURN a LIMIT 100 UNION MATCH (b) RETURN b LIMIT 100",
    );
  });

  it("fails closed on a UNION query with no LIMIT (cannot append)", () => {
    expect(() =>
      clampLimits("MATCH (a) RETURN a UNION MATCH (b) RETURN b", 100),
    ).toThrow(/UNION/);
  });

  it("fails closed on a parameterized LIMIT", () => {
    expect(() => clampLimits("MATCH (n) RETURN n LIMIT $limit", 100)).toThrow(
      /parameterized LIMIT/,
    );
  });

  it("is a no-op for a negative budget", () => {
    expect(clampLimits("MATCH (n) RETURN n LIMIT 1000", -1)).toBe(
      "MATCH (n) RETURN n LIMIT 1000",
    );
  });
});

describe("applyGraphScope", () => {
  it("injects scope params, clamps budget, and returns a tx timeout", () => {
    const scope: GraphScope = {
      labels: ["Doc"],
      relationshipTypes: ["REFERS_TO"],
      mode: "read",
      budget: { maxHops: 2, maxNodes: 100, maxTraversalMs: 250 },
    };
    const applied = applyGraphScope(
      `MATCH (a)-[r*1..9]->(b)
       WHERE any(l IN labels(a) WHERE l IN $${SCOPE_LABELS_PARAM})
         AND type(r) IN $${SCOPE_REL_TYPES_PARAM}
       RETURN b LIMIT 5000`,
      { seed: 1 },
      scope,
    );
    expect(applied.cypher).toContain("[r*1..2]");
    expect(applied.cypher).toContain("LIMIT 100");
    expect(applied.params).toMatchObject({
      seed: 1,
      [SCOPE_LABELS_PARAM]: ["Doc"],
      [SCOPE_REL_TYPES_PARAM]: ["REFERS_TO"],
    });
    expect(applied.txConfig).toEqual({ timeout: 250 });
  });

  it("omits txConfig when maxTraversalMs is not set", () => {
    const applied = applyGraphScope("MATCH (n) RETURN n", {}, {});
    expect(applied.txConfig).toBeUndefined();
    expect(applied.cypher).toBe("MATCH (n) RETURN n");
    expect(applied.params).toEqual({});
  });

  it("rejects writes when mode is read", () => {
    expect(() =>
      applyGraphScope(
        "MATCH (n) WHERE n.orgId=$orgId DELETE n",
        {},
        {
          mode: "read",
        },
      ),
    ).toThrow(GraphScopeError);
  });

  it("preserves write syntax while enforcing traversal budgets", () => {
    const query = "MATCH (a)-[r*1..9]->(b) SET b.seen = true";
    const result = applyGraphScope(
      query,
      {},
      {
        mode: "extend",
        budget: { maxNodes: 100, maxHops: 2, maxTraversalMs: 250 },
      },
    );
    expect(result.cypher).toBe("MATCH (a)-[r*1..2]->(b) SET b.seen = true");
    expect(result.txConfig).toEqual({ timeout: 250 });
  });

  it("allows writes when mode is extend", () => {
    expect(() =>
      applyGraphScope("MERGE (n {orgId:$orgId})", {}, { mode: "extend" }),
    ).not.toThrow();
  });

  it("enforces the bypass guard before any clamp", () => {
    expect(() =>
      applyGraphScope("MATCH (n) RETURN n", {}, { labels: ["Doc"] }),
    ).toThrow(/\$__scopeLabels/);
  });

  it("rejects a caller-supplied reserved param", () => {
    expect(() =>
      applyGraphScope(
        `MATCH (n) WHERE labels(n) IN $${SCOPE_LABELS_PARAM} RETURN n`,
        { [SCOPE_LABELS_PARAM]: ["x"] },
        { labels: ["Doc"] },
      ),
    ).toThrow(/Reserved scope parameter/);
  });
});

// ── The inline predicate is a region, not a list of shapes ───────────────────
//
// Round twelve reported a SUBQUERY brace inside `MATCH (n WHERE …)`; round
// thirteen reported a MAP LITERAL brace in the same place. They are one defect.
// A node pattern is
//
//     ( [variable] [labelExpression] [propertyMap] [WHERE expression] )
//
// and a relationship pattern is that shape inside `[…]`, so the `WHERE` is the
// point where the property-map position ENDS. Everything after it in that
// bracket is ordinary expression syntax. The scanner had been asking only
// whether the enclosing bracket is a pattern — true for the whole frame — so
// every brace and every bracket written in the region inherited the standing of
// the pattern's own property map.
//
// Ordering `opensSubquery` first (round twelve's fix, kept and still pinned
// above) closed one brace MEANING in the region. This closes the REGION, which
// is why the cases below are enumerated from the grammar rather than from what
// was demonstrated: fifteen queries reach it and one rule answers all of them.
//
// Every case here fails against the parent commit.
describe("an inline pattern predicate ends the property-map position", () => {
  const bypasses: Array<[name: string, cypher: string]> = [
    // The reported spelling. A map literal is never null, so the predicate is
    // constant-true and every tenant's `n` is returned.
    [
      "a map literal (review's round-13 case)",
      "MATCH (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    // The same map, reached by every other route an expression offers.
    [
      "a map literal parenthesised",
      "MATCH (n WHERE ({orgId: $orgId}) IS NOT NULL) RETURN n",
    ],
    [
      "a map literal in a CASE arm",
      "MATCH (n WHERE CASE WHEN true THEN {orgId: $orgId} END IS NOT NULL) RETURN n",
    ],
    [
      "a map whose VALUE holds the whole comparison",
      "MATCH (n WHERE {k: n.orgId = $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "a map nested one level inside another map",
      "MATCH (n WHERE {a: {orgId: $orgId}} IS NOT NULL) RETURN n",
    ],
    [
      "a map following a map PROJECTION in the same predicate",
      "MATCH (n WHERE n{.orgId} IS NOT NULL AND {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    // A grouping paren inside the region. Round eleven admits `(` after `=`
    // inside a graph-pattern clause, because `MATCH p = (a)` spells a node
    // pattern exactly that way — so without the region the map would be that
    // "pattern"'s property map one bracket deeper.
    [
      "a grouping paren inside the predicate",
      "MATCH (n WHERE true = ({orgId: $orgId} IS NOT NULL)) RETURN n",
    ],
    // A pattern comprehension inside the region: same, via `[`.
    [
      "a pattern comprehension inside the predicate",
      "MATCH (n WHERE size([(n)-->(m {orgId: $orgId}) | m]) > 0) RETURN n",
    ],
    // The region is not a property of node patterns — a relationship pattern
    // carries an inline predicate in exactly the same position.
    [
      "on a RELATIONSHIP pattern rather than a node",
      "MATCH (a)-[r WHERE {orgId: $orgId} IS NOT NULL]->(b) RETURN a",
    ],
    // Nor of the first pattern in the path, nor of MATCH specifically.
    [
      "on the second node of a path",
      "MATCH (a)-[r]->(m WHERE {orgId: $orgId} IS NOT NULL) RETURN a",
    ],
    [
      "under OPTIONAL MATCH",
      "OPTIONAL MATCH (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "under MERGE, where a pattern map would otherwise filter",
      "MERGE (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "after a label expression",
      "MATCH (n:GraphNode WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "inside a quantified path pattern",
      "MATCH ((a WHERE {orgId: $orgId} IS NOT NULL)-[r]->(b)){1,3} RETURN a",
    ],
    // One inline predicate inside another, through a subquery. The inner
    // pattern gets its own region; the map is in it.
    [
      "an inline predicate nested inside another",
      "MATCH (n WHERE EXISTS { MATCH (m WHERE {orgId: $orgId} IS NOT NULL) RETURN m }) RETURN n",
    ],
  ];

  for (const [name, cypher] of bypasses) {
    it(`is not a property map: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    });
  }

  it("is discriminating: the anchor's exact syntax is present in every case", () => {
    // Each query above carries `orgId: $orgId` or `<var>.orgId = $orgId`
    // verbatim, so the guard regex matches the raw text and only the position
    // rule refuses it. Without this the block could pass on a regex that had
    // stopped matching anything.
    for (const [, cypher] of bypasses) {
      expect(/(?:[A-Za-z]\.orgId\s*=|\borgId\s*:)\s*\$orgId/.test(cypher)).toBe(
        true,
      );
    }
  });

  // The other direction, held to the same standard. A pattern property map is
  // written BEFORE the `WHERE`, so it is outside the region and is the real
  // anchor Cypher says it is; and the region dies with the bracket it belongs
  // to, so a later pattern in the same clause is untouched.
  const stillAnchors: Array<[name: string, cypher: string]> = [
    [
      "a property map BEFORE the inline predicate on the same node",
      "MATCH (n {orgId: $orgId} WHERE {x: 1} IS NOT NULL) RETURN n",
    ],
    [
      "a property map before an ordinary inline predicate",
      "MATCH (n {orgId: $orgId} WHERE n.x > 1) RETURN n",
    ],
    [
      "a later node's property map in the same path",
      "MATCH (a WHERE a.x = 1)-[r]->(b {orgId: $orgId}) RETURN b",
    ],
    [
      "a later RELATIONSHIP's property map in the same path",
      "MATCH (a WHERE a.x = 1)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    [
      "a comma-separated second pattern's map",
      "MATCH (a WHERE a.x = 1), (b {orgId: $orgId}) RETURN b",
    ],
    [
      "a following MATCH's property map",
      "MATCH (a WHERE a.x = 1) MATCH (b {orgId: $orgId}) RETURN b",
    ],
    [
      "a following MERGE's property map",
      "MERGE (a {orgId: $orgId}) MERGE (b WHERE b.x = 1) RETURN a",
    ],
    // A subquery brace opens its OWN clause sequence, so the enclosing
    // pattern's inline predicate does not reach into it — the same reading that
    // already saves and restores `clause` across a brace. The top-level
    // spelling of this query is pinned as anchoring in the block above, and the
    // two had better not disagree.
    [
      "a pattern map inside a subquery inside the predicate",
      "MATCH (n WHERE EXISTS { MATCH (m {orgId: $orgId}) }) RETURN n",
    ],
    // The region is entered on a WHERE that STARTS A CLAUSE. The same
    // disqualifiers the clause branch uses keep a property key, a label and a
    // map value from spoofing it.
    [
      "a map key spelled `where`",
      "MATCH (n {where: 1, orgId: $orgId}) RETURN n",
    ],
    ["a label spelled `Where`", "MATCH (n:Where {orgId: $orgId}) RETURN n"],
    [
      "a property spelled `where` in a real WHERE",
      "MATCH (n) WHERE n.where = 1 AND n.orgId = $orgId RETURN n",
    ],
    [
      "a backtick-escaped variable spelled `where`",
      "MATCH (`where` {orgId: $orgId}) RETURN 1",
    ],
    // Unrelated shapes, re-pinned here because this change touches the bracket
    // stack every one of them rides on.
    ["a plain node property map", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "a plain relationship property map",
      "MATCH (a)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    ["a plain WHERE", "MATCH (n) WHERE n.orgId = $orgId RETURN n"],
  ];

  for (const [name, cypher] of stillAnchors) {
    it(`still anchors: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).toContain("$orgId");
    });
  }

  // THE MEASURED COST, stated rather than discovered later.
  //
  // An anchor written ONLY inside an inline predicate — `MATCH (n WHERE
  // n.orgId = $orgId)` — is refused. That is not new in this change: the region
  // is never the `WHERE` clause, because clause keywords are recognised at
  // paren/bracket depth 0 and the pattern's own bracket is open, so the
  // predicate's text was already being blanked before this commit. It is
  // recorded here because the region now has a name, and someone reading the
  // rule would otherwise expect it to have made the text a predicate position.
  //
  // Making it one is a real improvement and a DIFFERENT change: it would have
  // to keep the region's text while still refusing every brace inside it, and
  // it would need clause tracking inside a paren-nested subquery, which the
  // scanner does not have. Fail-closed, 0 of the 63 corpus queries.
  it("does not turn the region into a predicate position", () => {
    expect(
      keepFilteringPositions("MATCH (n WHERE n.orgId = $orgId) RETURN n"),
    ).not.toContain("$orgId");
    expect(
      keepFilteringPositions(
        "MATCH (a)-[r WHERE r.orgId = $orgId]->(b) RETURN a",
      ),
    ).not.toContain("$orgId");
    // The pattern-map spelling of the same intent is unaffected.
    expect(
      keepFilteringPositions("MATCH (n {orgId: $orgId}) RETURN n"),
    ).toContain("$orgId");
  });

  // A BARE variable spelled `where` opens the region and costs that query its
  // anchor. It is the fail-closed side of the class ADR-087 records for
  // `RETURN n AS where`, and it is unreachable in Cypher besides: `WHERE` is a
  // reserved word, so the database requires the backticks that
  // `stripLiteralsAndComments` has already emptied — which is why the escaped
  // spelling is pinned as still anchoring above.
  it("reads a bare variable spelled `where` as opening the region", () => {
    expect(
      keepFilteringPositions("MATCH (where {orgId: $orgId}) RETURN where"),
    ).not.toContain("$orgId");
  });

  // The SCOPE guard's projection drops the pattern-map position outright
  // (round eight), so none of this could reach it. Asserted so the asymmetry
  // stays a recorded property rather than a coincidence.
  it("the scope guard was already immune, by round eight's policy split", () => {
    for (const cypher of [
      `MATCH (n WHERE {a: n.label IN $${SCOPE_LABELS_PARAM}} IS NOT NULL) RETURN n`,
      `MATCH (n WHERE n.label IN $${SCOPE_LABELS_PARAM}) RETURN n`,
    ]) {
      expect(keepPredicatePositions(cypher)).not.toContain(
        `$${SCOPE_LABELS_PARAM}`,
      );
      expect(() => assertScopeMarkers(cypher, { labels: ["Doc"] })).toThrow(
        GraphScopeError,
      );
    }
  });
});

// ── A subquery's clause baseline is its own ─────────────────────────────────
//
// Round 14, and it is round 13's finding one scale up. Round 13: the rules asked
// their questions of a BRACKET, as though a bracket were homogeneous. This:
// clause recognition asked its question of the WHOLE QUERY, as though depth were
// global — when a subquery is a clause sequence with its own baseline.
//
// Absolute depth 0 is correct only for the outermost sequence. Nest a subquery
// under any paren or bracket and its own clauses stop being recognised, so the
// OUTER clause stays in force over the subquery's entire body:
//
//     MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine })
//                > 0 RETURN n
//
// The projected comparison is a column and filters nothing, but the inherited
// `WHERE` made it a predicate; `COLLECT` is non-empty whenever any node exists,
// so every tenant's `n` came back.
//
// Round 12 met this mechanism from its OTHER side — an anchor written only in a
// nested subquery's `WHERE` was refused — recorded it as a fail-closed cost, and
// declined to fix it because recognising clauses inside a paren-nested brace
// "would OPEN kept regions". That is backwards, and the inversion is the lesson:
// the property that refuses something legitimate is the same property that
// accepts something illegitimate from the other side. Recognition NARROWS. With
// it off one inherited `WHERE` covered projections and writes alike; with it on
// a `RETURN` is a `RETURN` and a `SET` is a `SET`.
describe("a subquery's clause baseline is its own", () => {
  const bypasses: Array<[name: string, cypher: string]> = [
    [
      "under a function call (review's case)",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine }) > 0 RETURN n",
    ],
    [
      "under a grouping paren",
      "MATCH (n) WHERE (COLLECT { MATCH (m) RETURN m.orgId = $orgId AS x }) <> [] RETURN n",
    ],
    [
      "EXISTS under a function call",
      "MATCH (n) WHERE toBoolean(EXISTS { MATCH (m) RETURN m.orgId = $orgId AS x }) RETURN n",
    ],
    [
      "COUNT under a function call",
      "MATCH (n) WHERE abs(COUNT { MATCH (m) RETURN m.orgId = $orgId AS x }) > 0 RETURN n",
    ],
    [
      "CALL nested inside a nested subquery",
      "MATCH (n) WHERE size(COLLECT { CALL { MATCH (m) RETURN m.orgId = $orgId AS x } RETURN 1 }) > 0 RETURN n",
    ],
    [
      "under a list bracket rather than a paren",
      "MATCH (n) WHERE size([x IN COLLECT { MATCH (m) RETURN m.orgId = $orgId AS q } | x]) > 0 RETURN n",
    ],
    [
      "two brackets deep",
      "MATCH (n) WHERE size(head([COLLECT { MATCH (m) RETURN m.orgId = $orgId AS q }])) > 0 RETURN n",
    ],
    [
      "with a WITH between the MATCH and the projection",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) WITH m RETURN m.orgId = $orgId AS q }) > 0 RETURN n",
    ],
    [
      "inside a CASE",
      "MATCH (n) WHERE CASE WHEN size(COLLECT { MATCH (m) RETURN m.orgId = $orgId AS q }) > 0 THEN true END RETURN n",
    ],
    // The worst spelling: not a projection but a WRITE, read as a filtering
    // position. `SET n.orgId = $orgId` reassigns every tenant's nodes to the
    // caller, which is the exact case the SET rule exists to refuse.
    [
      "a SET inside the nested subquery",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) SET m.orgId = $orgId RETURN m }) > 0 RETURN n",
    ],
  ];

  for (const [name, cypher] of bypasses) {
    it(`does not inherit the outer clause: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    });
  }

  it("is discriminating: the anchor's exact syntax is present in every case", () => {
    for (const [, cypher] of bypasses) {
      expect(/[A-Za-z]\.orgId\s*=\s*\$orgId/.test(cypher)).toBe(true);
    }
  });

  // The scope guard had the identical hole. `keepPredicatePositions` keeps a
  // WHERE clause, and the inherited WHERE was one, so a projected membership
  // test satisfied the agent allow-list too.
  const markerBypasses: Array<[name: string, cypher: string]> = [
    [
      "a projected membership test under a function call",
      `MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m.label IN $${SCOPE_LABELS_PARAM} AS ok }) > 0 RETURN n`,
    ],
    [
      "the same under a grouping paren",
      `MATCH (n) WHERE (COLLECT { MATCH (m) RETURN m.label IN $${SCOPE_LABELS_PARAM} AS ok }) <> [] RETURN n`,
    ],
  ];

  for (const [name, cypher] of markerBypasses) {
    it(`does not satisfy the allow-list: ${name}`, () => {
      expect(keepPredicatePositions(cypher)).not.toContain(
        `$${SCOPE_LABELS_PARAM}`,
      );
      expect(() => assertScopeMarkers(cypher, { labels: ["Doc"] })).toThrow(
        GraphScopeError,
      );
    });
  }

  // The other direction, and this is where round 14 REMOVES two refusals rather
  // than adding them. Both were round 12's recorded cost; both are the same
  // mechanism seen from its fail-closed side.
  const nowAnchors: Array<[name: string, cypher: string]> = [
    [
      "an anchor in a nested subquery's own WHERE",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) WHERE m.orgId = $orgId RETURN m }) > 0 RETURN n",
    ],
    [
      "an anchor in an inline-predicate subquery's WHERE",
      "MATCH (n WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId }) RETURN n",
    ],
    [
      "a pattern map in a nested subquery",
      "MATCH (n) WHERE size(COLLECT { MATCH (m {orgId: $orgId}) RETURN m }) > 0 RETURN n",
    ],
  ];

  for (const [name, cypher] of nowAnchors) {
    it(`now anchors: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).toContain("$orgId");
    });
  }

  it("the same three agree with their top-level spellings", () => {
    // Which is the property that makes the change a correction rather than a
    // loosening: the nested form and the depth-0 form now give one answer.
    for (const cypher of [
      "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId } RETURN n",
      "MATCH (n) WHERE EXISTS { MATCH (m {orgId: $orgId}) } RETURN n",
      "CALL { MATCH (n) WHERE n.orgId = $orgId RETURN n } RETURN n",
    ]) {
      expect(keepFilteringPositions(cypher)).toContain("$orgId");
    }
  });

  // A subquery starts with NO clause in force, so a body that opens with
  // something other than a clause keyword — Cypher 5's bare-pattern `EXISTS { … }`
  // — keeps nothing. Fail-closed, and it was already refused before round 14
  // for a different reason (the enclosing clause made the brace a map); pinned
  // so the reason is now the right one.
  it("a bare-pattern subquery keeps nothing on its own", () => {
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE EXISTS { (n)-[:R]->(m {orgId: $orgId}) } RETURN n",
      ),
    ).not.toContain("$orgId");
    // …and the query is accepted when the tenant is anchored outside it.
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE EXISTS { (n)-[:R]->(m) } AND n.orgId = $orgId RETURN n",
      ),
    ).toContain("$orgId");
  });

  // THE BASELINE HAS TO BE RESTORED WHEN THE SUBQUERY CLOSES, and leaving it
  // raised is its own bypass — found by mutation, not by review. The subquery
  // above opened at paren 1, so without the restore the baseline STAYS at 1 and
  // every clause keyword after the closing brace, back at depth 0, goes
  // unrecognised. The saved `clause` (`WHERE`) is then still in force over the
  // rest of the query, and the trailing projection — or a trailing SET — is read
  // as a predicate. Same defect as the one above, on the way out instead of the
  // way in.
  const afterTheSubqueryCloses: Array<[name: string, cypher: string]> = [
    [
      "a trailing RETURN projection",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m }) > 0 RETURN n, n.orgId = $orgId AS x",
    ],
    [
      "a trailing SET, which is a write",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m }) > 0 SET n.orgId = $orgId",
    ],
    [
      "after two nested subqueries in the same predicate",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m }) > 0 AND size(COLLECT { MATCH (p) RETURN p }) > 0 RETURN n, n.orgId = $orgId AS x",
    ],
  ];

  for (const [name, cypher] of afterTheSubqueryCloses) {
    it(`restores the baseline on close: ${name}`, () => {
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    });
  }

  // A SUBQUERY STARTS WITH NO CLAUSE IN FORCE, and that too is load-bearing
  // rather than tidiness. Cypher 5 lets a subquery expression hold a bare
  // PATTERN with no `MATCH` keyword, so without the reset there is no keyword to
  // displace the outer clause and the enclosing `WHERE` governs the body — the
  // same leak as above, reached without any nesting at all. With the reset the
  // body keeps nothing until it names its own clause.
  //
  // The cost is that a bare-pattern subquery's INLINE predicate is refused,
  // which is round 13's recorded cost (an inline predicate is never a predicate
  // position) rather than a new one, and is fail-closed.
  it("a bare-pattern subquery does not inherit the enclosing WHERE", () => {
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE EXISTS { (m WHERE m.orgId = $orgId) } RETURN n",
      ),
    ).not.toContain("$orgId");
    // The MATCH-keyword spelling of the same intent does anchor, because the
    // subquery then names its own clause.
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId } RETURN n",
      ),
    ).toContain("$orgId");
  });

  // Unrelated shapes that ride the same clause state, re-pinned because the
  // baseline is now a variable rather than the constant 0.
  const unchanged: Array<[name: string, cypher: string, anchors: boolean]> = [
    ["a plain WHERE", "MATCH (n) WHERE n.orgId = $orgId RETURN n", true],
    ["a plain pattern map", "MATCH (n {orgId: $orgId}) RETURN n", true],
    [
      "a top-level RETURN projection",
      "MATCH (n) RETURN n, n.orgId = $orgId AS mine",
      false,
    ],
    [
      "a top-level SET target",
      "MATCH (n) SET n.orgId = $orgId RETURN n",
      false,
    ],
    [
      "a top-level subquery's RETURN projection",
      "MATCH (n) WHERE EXISTS { MATCH (m) RETURN m.orgId = $orgId AS x } RETURN n",
      false,
    ],
    [
      "an inline-predicate map literal (round 13)",
      "MATCH (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
      false,
    ],
    [
      "a clause restored after the subquery closes",
      "MATCH (n) WHERE EXISTS { MATCH (m) RETURN m } AND n.orgId = $orgId RETURN n",
      true,
    ],
    [
      "a SET after a subquery is still a SET",
      "MATCH (n) WHERE EXISTS { MATCH (m) RETURN m } SET n.orgId = $orgId",
      false,
    ],
  ];

  for (const [name, cypher, anchors] of unchanged) {
    it(`unchanged (${anchors ? "anchors" : "refused"}): ${name}`, () => {
      const kept = keepFilteringPositions(cypher);
      if (anchors) expect(kept).toContain("$orgId");
      else expect(kept).not.toContain("$orgId");
    });
  }
});

// ── The sanitizer, audited against the lexer rather than against a finding ──
//
// `stripLiteralsAndComments` is the layer UNDER every position rule in this
// file: the tenancy anchor, the scope markers, the read-mode write rejection
// and the clause tracking all read its output. Five rounds of position rules
// each assumed it produced a faithful projection of which text is live, and
// nothing had checked that it did.
//
// The reference is Neo4j's own `Cypher25Lexer.g4` (`neo4j/cypher-language-support`,
// `packages/language-support/src/antlr-grammar`). Writing `CLOSE` for an
// asterisk followed by a slash:
//
//     MULTI_LINE_COMMENT    : '/CLOSE' .*? 'CLOSE'   — non-greedy: FIRST close
//     SINGLE_LINE_COMMENT   : '//' ~[\r\n]*          — CR or LF ends it
//     STRING_LITERAL1       : '\'' (~['\\] | EscapeSequence)* '\''
//     STRING_LITERAL2       : '"'  (~["\\] | EscapeSequence)* '"'
//     fragment EscapeSequence : '\\' .               — backslash + ANY char
//     ESCAPED_SYMBOLIC_NAME : '`' ( ~'`' | '``' )* '`' — doubling, no backslash
describe("the sanitizer agrees with Cypher about which text is live", () => {
  // ── Block comments do not nest ────────────────────────────────────────────
  //
  // Reported as a bypass on the premise that Neo4j keeps a doubled-open comment
  // commented to the OUTER terminator while this module closes at the first.
  // The grammar's `.*?` is non-greedy, so Neo4j closes at the first one too.
  // These pin the agreement rather than the absence of a fix.
  it("closes a block comment at the first terminator, as the lexer does", () => {
    const doubled =
      "/* outer /* inner */ WHERE n.orgId = $orgId */ MATCH (n) RETURN n";
    // Everything after the FIRST terminator is live — including the stray
    // second terminator, which is what makes the leftover a syntax error at the
    // database rather than a query that runs unscoped.
    expect(stripLiteralsAndComments(doubled)).toBe(
      "  WHERE n.orgId = $orgId */ MATCH (n) RETURN n",
    );
    // If the construct DID nest, everything up to the second terminator would
    // be comment and the live text would begin at ` MATCH`. It does not.
    expect(stripLiteralsAndComments(doubled)).not.toBe("  MATCH (n) RETURN n");
  });

  it("a second opener inside a block comment is ordinary comment text", () => {
    expect(stripLiteralsAndComments("MATCH (n) /* a /* b */ RETURN n")).toBe(
      "MATCH (n)   RETURN n",
    );
  });

  // ── A line comment ends at CR as well as LF ───────────────────────────────
  //
  // This was the real defect, and it failed in the dangerous direction: the
  // sanitizer hid text the database executes, so `assertReadOnly` — a DENYLIST,
  // which refuses only what it can SEE — found no write keyword.
  const CR = "\r";
  const lineTerminators: Array<[name: string, query: string]> = [
    ["LF", "MATCH (n) // c\nWHERE n.orgId = $orgId RETURN n"],
    ["CRLF", `MATCH (n) // c${CR}\nWHERE n.orgId = $orgId RETURN n`],
    ["a lone CR", `MATCH (n) // c${CR}WHERE n.orgId = $orgId RETURN n`],
  ];

  for (const [name, query] of lineTerminators) {
    it(`ends a line comment at ${name}`, () => {
      // The anchor is on the far side of the terminator, so it is only visible
      // if the comment ended where Cypher ends it.
      expect(keepFilteringPositions(query)).toContain("$orgId");
    });
  }

  it("does not hide a write behind a lone CR", () => {
    // `RETURN n // c` CR `DETACH DELETE n`: Cypher ends the comment at the CR
    // and executes the DELETE. Scanning only for LF hid it, and a read-mode
    // scope let it through.
    const hidden = `MATCH (n) WHERE n.orgId = $orgId RETURN n // c${CR}DETACH DELETE n`;
    expect(() => assertReadOnly(hidden)).toThrow(GraphScopeError);
    // Discriminating: the LF spelling of the same query was always refused, so
    // this asserts the two now agree rather than that the guard rejects
    // everything.
    const visible =
      "MATCH (n) WHERE n.orgId = $orgId RETURN n // c\nDETACH DELETE n";
    expect(() => assertReadOnly(visible)).toThrow(GraphScopeError);
    // …and a write genuinely inside the comment is still permitted, on both.
    expect(() =>
      assertReadOnly(
        `MATCH (n) WHERE n.orgId = $orgId RETURN n // DETACH DELETE n`,
      ),
    ).not.toThrow();
  });

  it("a comment that runs to end of input is complete, not unterminated", () => {
    // `~[\r\n]*` matches happily to end of input, so the text after `//` with no
    // newline is genuinely commented and the query is still well formed.
    const q = "MATCH (n) WHERE n.orgId = $orgId RETURN n // DETACH DELETE n";
    expect(keepFilteringPositions(q)).toContain("$orgId");
    expect(() => assertReadOnly(q)).not.toThrow();
  });

  // ── Whichever delimiter opens first wins ──────────────────────────────────
  //
  // The property the single-pass design exists to provide, in both directions.
  // Already correct; pinned because a future "tidy" into two regex passes could
  // only ever get one of the two right.
  const inert: Array<[name: string, query: string]> = [
    [
      "a block opener inside a string",
      "MATCH (n) WHERE n.u = '/*' AND n.orgId = $orgId RETURN n",
    ],
    [
      "a line opener inside a string",
      "MATCH (n) WHERE n.u = 'http://x' AND n.orgId = $orgId RETURN n",
    ],
    [
      "a block opener inside a backtick name",
      "MATCH (n) WHERE n.`/*` = 1 AND n.orgId = $orgId RETURN n",
    ],
    [
      "an apostrophe inside a block comment",
      "MATCH (n) /* it's fine */ WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "an apostrophe inside a line comment",
      "MATCH (n) // it's fine\nWHERE n.orgId = $orgId RETURN n",
    ],
    [
      "a line opener inside a block comment",
      "MATCH (n) /* // */ WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "a block opener inside a line comment",
      "MATCH (n) // /*\nWHERE n.orgId = $orgId RETURN n",
    ],
  ];

  for (const [name, query] of inert) {
    it(`treats ${name} as inert`, () => {
      expect(keepFilteringPositions(query)).toContain("$orgId");
      expect(() => assertReadOnly(query)).not.toThrow();
    });
  }

  it("a write inside a string or a backtick name is not a write", () => {
    // The other half of the same property: the sanitizer must not let a literal
    // spoof the denylist either.
    expect(() =>
      assertReadOnly(
        "MATCH (n) WHERE n.x = 'DETACH DELETE n' AND n.orgId = $orgId RETURN n",
      ),
    ).not.toThrow();
    expect(() =>
      assertReadOnly(
        "MATCH (n) WHERE n.`DELETE` = 1 AND n.orgId = $orgId RETURN n",
      ),
    ).not.toThrow();
  });

  // ── Escapes are per the grammar, and the two rules differ ─────────────────
  it("a backslash escapes any character inside a string", () => {
    // `EscapeSequence : '\\' .` — so an escaped closing quote does not close.
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE n.x = 'a\\'b' AND n.orgId = $orgId RETURN n",
      ),
    ).toContain("$orgId");
    // A trailing escaped backslash DOES let the next quote close.
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE n.x = 'a\\\\' AND n.orgId = $orgId RETURN n",
      ),
    ).toContain("$orgId");
  });

  it("a backtick name escapes by doubling and takes no backslash escape", () => {
    // `ESCAPED_SYMBOLIC_NAME : '`' ( ~'`' | '``' )* '`'` has no EscapeSequence,
    // so a backslash is an ordinary character and the next backtick closes.
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE n.`a``b` = 1 AND n.orgId = $orgId RETURN n",
      ),
    ).toContain("$orgId");
    expect(
      keepFilteringPositions(
        "MATCH (n) WHERE n.`a\\` = 1 AND n.orgId = $orgId RETURN n",
      ),
    ).toContain("$orgId");
  });

  // ── Unterminated input has no faithful projection, so it is refused ───────
  //
  // None of these lex in Cypher, so none could ever have run — the query was
  // rejected by the DATABASE. That is an external guarantee standing in for a
  // local one, which is the arrangement this PR has spent several rounds
  // replacing.
  const unterminated: Array<[name: string, query: string]> = [
    [
      "a block comment",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n /* DETACH DELETE n",
    ],
    [
      "a single-quoted string",
      "MATCH (n) WHERE n.orgId = $orgId AND n.x = 'oops DETACH DELETE n",
    ],
    [
      "a double-quoted string",
      'MATCH (n) WHERE n.orgId = $orgId AND n.x = "oops DETACH DELETE n',
    ],
    [
      "a backtick identifier",
      "MATCH (n) WHERE n.orgId = $orgId AND n.`oops DETACH DELETE n",
    ],
  ];

  for (const [name, query] of unterminated) {
    it(`refuses ${name} that never closes`, () => {
      // The allow-list guards fail closed by finding nothing in a filtering
      // position…
      expect(keepFilteringPositions(query)).not.toContain("$orgId");
      expect(keepFilteringPositions(query).trim()).toBe("");
      // …and the DENYLIST fails closed the opposite way, by refusing outright.
      // Blanking would have been the most permissive possible answer here,
      // since a blank string contains no write at all.
      expect(() => assertReadOnly(query)).toThrow(GraphScopeError);
      expect(() => assertReadOnly(query)).toThrow(/unterminated/);
    });
  }

  it("is discriminating: the closed spelling of each is accepted", () => {
    // Without this the block above would pass on a sanitizer that refused
    // everything.
    for (const q of [
      "MATCH (n) WHERE n.orgId = $orgId RETURN n /* fine */",
      "MATCH (n) WHERE n.orgId = $orgId AND n.x = 'fine' RETURN n",
      'MATCH (n) WHERE n.orgId = $orgId AND n.x = "fine" RETURN n',
      "MATCH (n) WHERE n.orgId = $orgId AND n.`fine` = 1 RETURN n",
    ]) {
      expect(keepFilteringPositions(q)).toContain("$orgId");
      expect(() => assertReadOnly(q)).not.toThrow();
    }
  });

  it("reports unterminated separately from the projection", () => {
    // The two entry points are one scanner. A second pass answering "is it
    // unterminated" would be a second lexer to keep in agreement with the
    // first, which is the class of defect this module exists to stop repeating.
    expect(scanLiteralsAndComments("MATCH (n) RETURN n")).toEqual({
      text: "MATCH (n) RETURN n",
      unterminated: false,
    });
    expect(scanLiteralsAndComments("MATCH (n) /* x").unterminated).toBe(true);
    expect(scanLiteralsAndComments("MATCH (n) 'x").unterminated).toBe(true);
    expect(scanLiteralsAndComments("MATCH (n) `x").unterminated).toBe(true);
    expect(scanLiteralsAndComments("MATCH (n) // x").unterminated).toBe(false);
    expect(stripLiteralsAndComments("MATCH (n) /* x")).toBe(
      scanLiteralsAndComments("MATCH (n) /* x").text,
    );
  });
});

describe("rowSelectingParts", () => {
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  const parts = (cypher: string) =>
    rowSelectingParts(cypher).map((p) => ({
      pattern: squash(p.pattern),
      anchors: squash(p.anchors),
      where: squash(p.where),
      branch: p.branch,
    }));

  it("splits a MATCH clause at its top-level commas and shares its WHERE", () => {
    expect(
      parts("MATCH (a {orgId: $orgId}), (b) WHERE b.x = 1 RETURN a, b"),
    ).toEqual([
      {
        pattern: "MATCH (a {orgId: $orgId})",
        anchors: "{orgId: $orgId",
        where: "WHERE b.x = 1",
        branch: 0,
      },
      { pattern: ", (b)", anchors: "", where: "WHERE b.x = 1", branch: 0 },
    ]);
  });

  it("keeps a comma inside a pattern map in its part", () => {
    expect(parts("MATCH (a {x: 1, orgId: $orgId}) RETURN a")).toHaveLength(1);
  });

  it("reads OPTIONAL MATCH as one clause and ON MATCH as none", () => {
    expect(
      parts(
        "MERGE (n {orgId: $orgId}) ON MATCH SET n.x = 1 WITH n OPTIONAL MATCH (n)-->(m) RETURN m",
      ),
    ).toEqual([
      {
        pattern: "OPTIONAL MATCH (n)-->(m)",
        anchors: "",
        where: "",
        branch: 0,
      },
    ]);
  });

  it("does not credit a USING hint to the pattern, and keeps the WHERE after it", () => {
    const [part] = parts(
      "MATCH (n:L) USING INDEX n:L(x) WHERE n.orgId = $orgId RETURN n",
    );
    expect(part?.pattern).toBe("MATCH (n:L)");
    expect(part?.where).toBe("WHERE n.orgId = $orgId");
  });

  it("gives a subquery's MATCH its own part and keeps it out of the outer WHERE", () => {
    expect(
      parts(
        "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId } AND n.x = 1 RETURN n",
      ),
    ).toEqual([
      {
        pattern: "MATCH (n)",
        anchors: "",
        where: "WHERE EXISTS } AND n.x = 1",
        branch: 0,
      },
      {
        pattern: "MATCH (m)",
        anchors: "",
        where: "WHERE m.orgId = $orgId",
        branch: 0,
      },
    ]);
  });

  it("numbers the top-level UNION branches", () => {
    expect(
      parts("MATCH (a) RETURN a UNION ALL MATCH (b) RETURN b").map(
        (p) => p.branch,
      ),
    ).toEqual([0, 1]);
  });

  it("reports no parts for a query without MATCH, or one it cannot project", () => {
    expect(parts("MERGE (n {orgId: $orgId}) RETURN n")).toEqual([]);
    expect(parts("MATCH (n) /* unterminated")).toEqual([]);
  });
});

describe("rowSelectingParts — a part's variables are its pattern elements'", () => {
  const variables = (cypher: string) =>
    rowSelectingParts(cypher).map((p) => [...p.variables]);

  it("reads the name written first inside each node and relationship bracket", () => {
    expect(variables("MATCH (a)-[r:R]->(b:L {x: 1}) RETURN a")).toEqual([
      ["a", "r", "b"],
    ]);
  });

  it("binds nothing for a label-only node, an anonymous relationship, or a bare map", () => {
    expect(variables("MATCH (:L)-[:R]->({x: 1})-[*1..3]-() RETURN 1")).toEqual([
      [],
    ]);
  });

  it("does not read a call, a list or a grouping in a property value as an element", () => {
    expect(
      variables(
        "MATCH (a) MATCH (b {x: toString(a.x), ys: [a.y], z: (a.z)}) RETURN b",
      ),
    ).toEqual([["a"], ["b"]]);
  });

  it("does not read a bracket inside an inline predicate as an element", () => {
    expect(
      variables(
        "MATCH (a) MATCH (b WHERE (a.x) = b.x AND a.y IN [b.y]) RETURN b",
      ),
    ).toEqual([["a"], ["b"]]);
  });

  it("does not read a path variable as an element", () => {
    expect(variables("MATCH p = (a)-->(b) RETURN p")).toEqual([["a", "b"]]);
  });

  it("gives each comma part its own elements", () => {
    expect(variables("MATCH (a), (b)-->(c) RETURN a")).toEqual([
      ["a"],
      ["b", "c"],
    ]);
  });

  it("keeps a variable written twice in one part", () => {
    expect(variables("MATCH (a)-->(b)-->(a) RETURN a")).toEqual([
      ["a", "b", "a"],
    ]);
  });
});

describe("rowSelectingScope", () => {
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  const events = (cypher: string) =>
    rowSelectingScope(cypher).map((e) => {
      switch (e.kind) {
        case "part":
          return `part ${squash(e.part.pattern)}`;
        case "with":
        case "return":
          return `${e.kind} ${squash(e.projection)}`;
        case "open":
          return `open ${e.subquery}${
            e.imports === null
              ? ""
              : e.imports === "all"
                ? " (*)"
                : ` (${e.imports.join(",")})`
          }`;
        default:
          return e.kind;
      }
    });

  it("interleaves WITH and RETURN projections with the parts, in source order", () => {
    expect(
      events("MATCH (n) WITH count(n) AS c, n MATCH (n)-->(m) RETURN m"),
    ).toEqual([
      "part MATCH (n)",
      "with count(n) AS c, n",
      "part MATCH (n)-->(m)",
      "return m",
    ]);
  });

  it("ends a projection at WHERE, ORDER BY, SKIP and LIMIT", () => {
    expect(
      events(
        "MATCH (n) WITH n WHERE n.x = 1 WITH n ORDER BY n.x SKIP 1 LIMIT 2 RETURN n",
      ),
    ).toEqual(["part MATCH (n)", "with n", "with n", "return n"]);
  });

  it("opens and closes a CALL body, with its own projections inside", () => {
    expect(
      events("MATCH (n) CALL { WITH n MATCH (n)-->(m) RETURN m } RETURN m"),
    ).toEqual([
      "part MATCH (n)",
      "open call",
      "with n",
      "part MATCH (n)-->(m)",
      "return m",
      "close",
      "return m",
    ]);
  });

  it("reads a scope clause's imports, and (*)", () => {
    expect(events("MATCH (n) CALL (n, m) { RETURN 1 } RETURN 1")).toEqual([
      "part MATCH (n)",
      "open call (n,m)",
      "return 1",
      "close",
      "return 1",
    ]);
    expect(events("CALL (*) { RETURN 1 } RETURN 1")).toEqual([
      "open call (*)",
      "return 1",
      "close",
      "return 1",
    ]);
    expect(events("CALL () { RETURN 1 } RETURN 1")).toEqual([
      "open call ()",
      "return 1",
      "close",
      "return 1",
    ]);
  });

  it("opens an expression subquery without imports", () => {
    expect(
      events("MATCH (n) WHERE EXISTS { MATCH (n)-->(m) } RETURN n"),
    ).toEqual([
      "part MATCH (n)",
      "open expression",
      "part MATCH (n)-->(m)",
      "close",
      "return n",
    ]);
  });

  it("parks the enclosing projection while a subquery inside it is read", () => {
    expect(
      events(
        "MATCH (n) WITH n, COUNT { MATCH (n)-->(m) RETURN m } AS c RETURN c",
      ),
    ).toEqual([
      "part MATCH (n)",
      "open expression",
      "part MATCH (n)-->(m)",
      "return m",
      "close",
      "with n, COUNT { MATCH (n)-->(m) RETURN m } AS c",
      "return c",
    ]);
  });

  it("records a UNION at any level", () => {
    expect(
      events(
        "CALL { MATCH (a) RETURN a UNION MATCH (b) RETURN b AS a } RETURN a UNION ALL MATCH (c) RETURN c AS a",
      ),
    ).toEqual([
      "open call",
      "part MATCH (a)",
      "return a",
      "union",
      "part MATCH (b)",
      "return b AS a",
      "close",
      "return a",
      "union",
      "part MATCH (c)",
      "return c AS a",
    ]);
  });

  it("blanks a literal inside a projection", () => {
    expect(events("MATCH (n) WITH n, 'x, y' AS s RETURN s")).toEqual([
      "part MATCH (n)",
      "with n, '' AS s",
      "return s",
    ]);
  });

  it("reports nothing for an input it cannot project", () => {
    expect(events("MATCH (n) /* unterminated")).toEqual([]);
  });
});

describe("projectedNames", () => {
  const source = new Set(["n", "m"]);
  const names = (projection: string) => [...projectedNames(projection, source)];

  it("keeps a bare variable that is in scope", () => {
    expect(names("n")).toEqual(["n"]);
    expect(names(" n , m ")).toEqual(["n", "m"]);
  });

  it("keeps everything for *", () => {
    expect(names("*")).toEqual(["n", "m"]);
    expect(names("*, count(n) AS c")).toEqual(["n", "m"]);
  });

  it("keeps a bare variable after DISTINCT, and not a name that starts with it", () => {
    expect(names("DISTINCT n")).toEqual(["n"]);
    expect(names("distinct n, m")).toEqual(["n", "m"]);
    expect(names("DISTINCTn")).toEqual([]);
  });

  it("keeps nothing for an expression, an alias, or a name not in scope", () => {
    expect(names("count(n) AS c")).toEqual([]);
    expect(names("n AS m")).toEqual([]);
    expect(names("n.x")).toEqual([]);
    expect(names("k")).toEqual([]);
    expect(names("n {.x}")).toEqual([]);
  });

  it("splits at top-level commas only", () => {
    expect(names("coalesce(n, m) AS c, m")).toEqual(["m"]);
    expect(names("[n, m] AS l, n")).toEqual(["n"]);
    expect(names("{a: n, b: m} AS o, m")).toEqual(["m"]);
    expect(names("COUNT { MATCH (n)-->(k) RETURN k, n } AS c, n")).toEqual([
      "n",
    ]);
  });

  it("is delimited by Cypher's identifier classes", () => {
    expect([...projectedNames("né", new Set(["n", "né"]))]).toEqual(["né"]);
  });
});

describe("expressionLocalBindings", () => {
  const spans = (text: string) =>
    expressionLocalBindings(text).map((r) => ({
      inside: text.slice(r.start, r.end + 1),
      names: [...r.names],
    }));

  it("binds a list predicate's variable to its paren", () => {
    expect(spans("WHERE any(x IN xs WHERE x > 0) AND n.y = 1")).toEqual([
      { inside: "(x IN xs WHERE x > 0)", names: ["x"] },
    ]);
  });

  it("binds a list comprehension's variable to its bracket", () => {
    expect(spans("WHERE [x IN xs WHERE x > 0 | x] <> []")).toEqual([
      { inside: "[x IN xs WHERE x > 0 | x]", names: ["x"] },
    ]);
  });

  it("binds reduce's accumulator and element, and not a grouping's first name", () => {
    expect(
      spans("WHERE reduce(acc = 0, x IN xs | acc + x) > (n.x = 1)"),
    ).toEqual([
      { inside: "(acc = 0, x IN xs | acc + x)", names: ["acc", "x"] },
    ]);
  });

  it("reads IN as a whole keyword, case-insensitively", () => {
    expect(spans("WHERE any(x in xs WHERE x > 0)")).toEqual([
      { inside: "(x in xs WHERE x > 0)", names: ["x"] },
    ]);
    expect(spans("WHERE f(x INx)")).toEqual([]);
    expect(spans("WHERE f(x, INx)")).toEqual([]);
  });

  it("does not read a property membership test as a binding", () => {
    expect(spans("WHERE n.x IN [1, 2] AND f(n.y IN xs)")).toEqual([]);
  });

  it("nests, keeping each bracket's own names", () => {
    expect(spans("WHERE any(x IN xs WHERE all(y IN ys WHERE x = y))")).toEqual([
      { inside: "(y IN ys WHERE x = y)", names: ["y"] },
      { inside: "(x IN xs WHERE all(y IN ys WHERE x = y))", names: ["x"] },
    ]);
  });

  it("reports an unclosed bracket to the end of the text", () => {
    expect(expressionLocalBindings("WHERE any(x IN xs")).toEqual([
      { start: 9, end: 17, names: ["x"] },
    ]);
  });

  it("reports nothing for a text with no bindings", () => {
    expect(spans("WHERE n.orgId = $orgId AND (n.x = 1 OR n.y = 2)")).toEqual(
      [],
    );
  });
});
