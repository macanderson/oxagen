import { describe, expect, it } from "vitest";
import {
  applyGraphScope,
  assertNoReservedParamCollision,
  assertReadOnly,
  assertScopeMarkers,
  buildScopeParams,
  clampLimits,
  clampVarLengthHops,
  GraphScopeError,
  keepFilteringPositions,
  keepPredicatePositions,
  SCOPE_LABELS_PARAM,
  SCOPE_REL_TYPES_PARAM,
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
