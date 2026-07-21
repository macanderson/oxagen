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

  it("treats a prefix-collision marker as absent (word boundary)", () => {
    expect(() =>
      assertScopeMarkers(
        "MATCH (n) WHERE n.x = $__scopeLabelsExtra RETURN n",
        withMarkers(true, false),
      ),
    ).toThrow(GraphScopeError);
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
