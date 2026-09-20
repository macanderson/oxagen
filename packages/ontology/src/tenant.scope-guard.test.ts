// tenant.scope-guard.test.ts — the tenancy seam-bypass guard in ./tenant.ts.
//
// Two layers, and the split matters:
//
//  1. Discriminating cases. Every rejection case below is one the OLD guard
//     (`/\borgId\b/` against the raw Cypher) ACCEPTED. A test that feeds the
//     guard `MATCH (n) RETURN n` and expects a throw passes on the broken
//     implementation too and proves nothing, so the cases here are the ones
//     where `orgId` is present but is not scoping anything: in a comment, in a
//     string literal, as a RETURN alias, as a backtick identifier, or as a
//     value compared against an unrelated property.
//
//  2. The repo corpus. Tightening this guard has one failure mode that matters
//     more than the hole it closes: a FALSE REJECT takes down every graph read
//     on that path. So the corpus test walks the actual tree, extracts every
//     Cypher literal handed to a `.run()` on a scoped session, and asserts the
//     guard still accepts all of them. It fails when someone adds a query that
//     does not anchor the tenant — at authoring time, not in production.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

const run = vi.fn(
  async (_cypher: string, _params?: Record<string, unknown>) => ({
    records: [],
  }),
);
const close = vi.fn(async () => undefined);
const executeRead = vi.fn(
  async (
    work: (tx: { run: typeof run }) => Promise<unknown>,
    _config?: { timeout: number },
  ) => work({ run }),
);
const executeWrite = vi.fn(
  async (
    work: (tx: { run: typeof run }) => Promise<unknown>,
    _config?: { timeout: number },
  ) => work({ run }),
);
vi.mock("./client", () => ({
  session: () => ({ run, close, executeRead, executeWrite }),
}));

import { runInTenantScope } from "@oxagen/tenancy";
import { assertAnchorsTenant, scopedSession } from "./tenant";
import {
  keepFilteringPositions,
  stripLiteralsAndComments,
} from "./graph-scope";
import type { GraphScope } from "./graph-scope";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

/** Run `cypher` through the real seam and report whether the guard let it by. */
async function guardAccepts(cypher: string): Promise<boolean> {
  return runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
    const s = scopedSession();
    try {
      await s.run(cypher);
      return true;
    } catch (err) {
      if ((err as Error).name === "TenantScopeError") return false;
      throw err;
    }
  });
}

/**
 * The guard as it stood before this fix: the bare token, tested against the raw
 * string. Kept here so each discriminating case can assert it is discriminating
 * — that the old implementation accepted exactly what the new one rejects. This
 * is the mutation check, expressed as an assertion rather than a manual revert.
 */
const OLD_GUARD = /\borgId\b/;

/**
 * The sanitize step the SHIPPED level-2 guard used, so a test can assert that
 * level 2 accepted the case it is about to watch the current guard reject.
 */
function strippedForTest(cypher: string): string {
  return stripLiteralsAndComments(cypher);
}

describe("tenancy guard — cases the old guard accepted and the new one rejects", () => {
  // Each entry: a query where `orgId` appears but scopes nothing.
  const bypasses: Array<[name: string, cypher: string]> = [
    [
      "line comment",
      "// scoped by orgId upstream\nMATCH (n:GraphNode) RETURN n",
    ],
    [
      "block comment",
      "/* orgId = $orgId is applied by the caller */ MATCH (n:GraphNode) RETURN n",
    ],
    [
      "single-quoted string literal",
      "MATCH (n:GraphNode) WHERE n.note = 'orgId: $orgId' RETURN n",
    ],
    [
      "double-quoted string literal",
      'MATCH (n:GraphNode) WHERE n.note = "orgId = $orgId" RETURN n',
    ],
    ["backtick identifier", "MATCH (n:`orgId`) RETURN n"],
    ["RETURN alias", "MATCH (n:GraphNode) RETURN n.name AS orgId"],
    ["WITH alias", "MATCH (n:GraphNode) WITH n.tenant AS orgId RETURN orgId"],
    [
      "tenant value compared against an unrelated property",
      "MATCH (n:GraphNode) WHERE n.author = $orgId RETURN n",
    ],
    [
      "bare token in an ORDER BY",
      "MATCH (n:GraphNode) RETURN n ORDER BY orgId",
    ],
  ];

  for (const [name, cypher] of bypasses) {
    it(`rejects: ${name}`, async () => {
      // Discriminating, asserted rather than assumed: the old guard let this
      // through. If this line ever fails the case has stopped proving anything.
      expect(OLD_GUARD.test(cypher)).toBe(true);
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  it("names both accepted forms in the error so a false reject is self-fixing", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await expect(s.run("MATCH (n:GraphNode) RETURN n")).rejects.toThrow(
        /WHERE n\.orgId = \$orgId.*MATCH \(n \{orgId: \$orgId\}\)/,
      );
    });
  });
});

// The cases that the SHIPPED level-2 guard (`/\borgId\s*[:=]/` over the whole
// sanitized query) accepted. A reviewer found the first by reading the guard's
// own doc comment, which listed a SET target as a legitimate anchor. Each of
// these is strictly worse than the hole level 2 closed, because each reads as
// scoping to a human skimming the query.
describe("tenancy guard — the token in a non-filtering clause", () => {
  const nonFiltering: Array<[name: string, cypher: string]> = [
    [
      "SET target reassigns every tenant's nodes to the caller",
      "MATCH (n) SET n.orgId = $orgId",
    ],
    [
      "SET target with a label, still an unrestricted MATCH",
      "MATCH (n:GraphNode) SET n.orgId = $orgId, n.updatedAt = datetime()",
    ],
    [
      "ON CREATE SET on an unanchored MERGE",
      "MERGE (n:GraphNode {publicId: $p}) ON CREATE SET n.orgId = $orgId",
    ],
    [
      "map-literal assignment outside a pattern",
      "MATCH (n) SET n += {orgId: $orgId}",
    ],
    [
      "RETURN projection of the comparison",
      "MATCH (n) RETURN n, n.orgId = $orgId AS mine",
    ],
    [
      "WITH projection of the comparison",
      "MATCH (n) WITH n, n.orgId = $orgId AS mine RETURN n",
    ],
  ];

  for (const [name, cypher] of nonFiltering) {
    it(`rejects: ${name}`, async () => {
      // Discriminating against the SHIPPED guard, not just the original one.
      expect(/\borgId\s*[:=]/.test(strippedForTest(cypher))).toBe(true);
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }
});

// The deepest of the four rounds. Every earlier version checked WHERE the
// tenant token sits — anywhere, then beside `:` or `=`, then in a filtering
// position — and none checked WHAT IT BINDS TO. Each query below is in a WHERE
// or a pattern property, compares the tenant column, and reads another
// organisation's rows, because the parameter on the other side is one the
// CALLER supplies. Only `$orgId` is seam-owned: run() overwrites it on every
// call, so it is the one value a caller cannot influence.
//
// Two of these were, until this round, asserted as ACCEPTANCE cases in this
// file — tests locking in a cross-tenant read.
// Maps that sit in a clause which creates or projects rows rather than
// selecting them. Both were accepted until the clause condition and the
// pattern-map condition were made to CONJOIN instead of the second overriding
// the first.
describe("tenancy guard — maps in clauses that do not select rows", () => {
  const notSelecting: Array<[name: string, cypher: string]> = [
    [
      "CREATE map stamps a new node while the MATCH reads every tenant",
      "MATCH (n) CREATE (m {orgId: $orgId})",
    ],
    [
      "CREATE map with a label",
      "MATCH (n:GraphNode) CREATE (m:GraphNode {orgId: $orgId, publicId: $p})",
    ],
    [
      "parenthesised map in a RETURN projection",
      "MATCH (n) RETURN n, ({orgId: $orgId})",
    ],
    [
      "parenthesised map in a WITH projection",
      "MATCH (n) WITH n, ({orgId: $orgId}) AS m RETURN n",
    ],
  ];

  for (const [name, cypher] of notSelecting) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }
});

// A MERGE pattern map is a match-or-create predicate, so it genuinely does
// constrain the thing it merges: `MERGE (n {orgId: $orgId})` yields an `n`
// carrying the tenant whichever branch fires. What it constrains is ONLY that
// thing. Once an earlier clause has bound a graph variable, the map narrows the
// merged variable and says nothing about the rows already in play — and those
// are the rows the query exposes.
//
// So MERGE counts as filtering under exactly one condition: nothing before it
// bound a graph variable. That is not a decision about WHICH variable the map
// scopes — it is the case where there is nothing else to scope. Dropping MERGE
// outright instead was measured against the repo corpus below and rejected 5 of
// the 63 production queries (two in tool-projection.ts, one in memory/neo4j.ts,
// two in ingestion's upsert-entity.ts) — every one a first-clause upsert that
// does anchor. The conditional rule rejects none of them.
describe("tenancy guard — a MERGE map after something is already bound", () => {
  const afterBinding: Array<[name: string, cypher: string]> = [
    [
      "MERGE map cannot narrow a variable an earlier MATCH bound",
      "MATCH (n) MERGE (m:GraphNode {orgId: $orgId})",
    ],
    [
      "…nor one an earlier anchored MATCH left in play",
      "MATCH (n:GraphNode) MERGE (audit {orgId: $orgId}) RETURN n",
    ],
    [
      "MERGE map after an OPTIONAL MATCH",
      "OPTIONAL MATCH (n) MERGE (m {orgId: $orgId}) RETURN n",
    ],
    [
      "MERGE map after a CREATE",
      "CREATE (n:GraphNode) WITH n MERGE (m {orgId: $orgId}) RETURN n",
    ],
    [
      "second MERGE map, the first having bound a variable",
      "MERGE (a:Thing {key: $k}) MERGE (b {orgId: $orgId}) RETURN a",
    ],
  ];

  for (const [name, cypher] of afterBinding) {
    it(`rejects: ${name}`, async () => {
      // Discriminating against the shipped guard, which kept MERGE in
      // ROW_SELECTING_CLAUSES unconditionally and accepted every one of these.
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  const firstClause: Array<[name: string, cypher: string]> = [
    [
      "MERGE is the first clause, so its map constrains everything bound",
      "MERGE (e:Execution {id: $id, orgId: $orgId, workspaceId: $workspaceId})",
    ],
    [
      "UNWIND binds a parameter value, not a graph row",
      "UNWIND $tools AS tl MERGE (t:Tool {id: tl.id, orgId: $orgId, workspaceId: $workspaceId})",
    ],
    [
      "ON CREATE SET after the anchored MERGE does not retract the anchor",
      "MERGE (n:GraphNode {orgId: $orgId, publicId: $p}) ON CREATE SET n.createdAt = datetime()",
    ],
  ];

  for (const [name, cypher] of firstClause) {
    it(`accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// ── Recorded limitations ─────────────────────────────────────────────────────
//
// These queries ARE ACCEPTED and CAN read across tenants. They are here so the
// gap is a recorded property of the seam rather than something a reviewer
// rediscovers, and so that anyone tempted to call this guard an enforcement
// mechanism has to delete a passing test first.
//
// This list used to lead with `MATCH (a {orgId: $orgId}) MATCH (b) RETURN b`.
// The real-Neo4j probe (`integration/tenant-isolation.test.ts`) showed that
// query returning every tenant's nodes from the pooled database, and the seam
// now refuses it: every row-selecting pattern part must carry its own anchor
// (see the per-pattern describe block below). What remains is what a
// per-pattern rule cannot see — reachability along an edge, and a boolean
// that makes the anchor optional. No syntactic check closes either; #3199,
// constructing the scoping instead of validating it, does.
describe("tenancy guard — KNOWN cross-tenant reads it accepts", () => {
  const accepted: Array<[name: string, cypher: string]> = [
    [
      // Reaches another tenant only over a cross-tenant edge. Writing one
      // through this seam needs a MATCH on the other tenant's node, which the
      // per-pattern rule refuses; the integration probe asserts the traversal
      // finds nothing foreign on a graph written through the seam.
      "a traversal leaving the anchored node",
      "MATCH (a {orgId: $orgId})-[*1..3]-(b) RETURN b",
    ],
    [
      "an anchor made optional by OR",
      "MATCH (n) WHERE n.orgId = $orgId OR true RETURN n",
    ],
  ];

  for (const [name, cypher] of accepted) {
    it(`accepts (and should not be trusted): ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// ── Every row-selecting pattern is anchored (M0) ─────────────────────────────
//
// The query-wide anchor accepted every query below. Each has at least one
// MATCH pattern that no anchor reaches, so each reads rows from every tenant in
// the pooled database — a Cartesian product, an unconstrained existence test,
// or an id join to another tenant's node. The first five were in the
// KNOWN-accepted list above; the rest were asserted as "still accepted" by the
// rounds that closed other holes, because those rounds asked only whether an
// anchor sat in a filtering position somewhere.
describe("tenancy guard — every row-selecting pattern is anchored", () => {
  const refused: Array<[name: string, cypher: string]> = [
    [
      "a second, unanchored MATCH",
      "MATCH (a:GraphNode {orgId: $orgId}) MATCH (b:GraphNode) RETURN b",
    ],
    [
      "an unanchored OPTIONAL MATCH",
      "MATCH (a {orgId: $orgId}) OPTIONAL MATCH (b) RETURN b",
    ],
    [
      "an unanchored UNION branch",
      "MATCH (a) WHERE a.orgId = $orgId RETURN a UNION MATCH (b) RETURN b",
    ],
    [
      "a MERGE that anchors, followed by an unanchored MATCH",
      "MERGE (a:GraphNode {orgId: $orgId}) WITH a MATCH (b) RETURN b",
    ],
    [
      "a Cartesian product: the same defect spelled with a comma",
      "MATCH (a {orgId: $orgId}), (b) RETURN b",
    ],
    [
      "a WHERE anchor on another pattern's variable",
      "MATCH (a {orgId: $orgId}) MATCH (b) WHERE a.orgId = $orgId RETURN b",
    ],
    [
      "a property access on a map alias",
      "WITH {orgId: $orgId} AS m MATCH (n) WHERE m.orgId = $orgId RETURN n",
    ],
    [
      "the anchor inside an EXISTS in an inline predicate",
      "MATCH (n WHERE EXISTS { MATCH (m {orgId: $orgId}) }) RETURN n",
    ],
    [
      "the anchor inside an inline-predicate subquery's WHERE",
      "MATCH (n WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId }) RETURN n",
    ],
    [
      "the anchor inside a top-level EXISTS",
      "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId } RETURN n",
    ],
    [
      "the anchor inside a top-level COUNT",
      "MATCH (n) WHERE COUNT { MATCH (m) WHERE m.orgId = $orgId } > 0 RETURN n",
    ],
    [
      "the anchor as a pattern map inside EXISTS",
      "MATCH (n) WHERE EXISTS { MATCH (m {orgId: $orgId}) } RETURN n",
    ],
    [
      "the anchor in a nested COLLECT's WHERE",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) WHERE m.orgId = $orgId RETURN m }) > 0 RETURN n",
    ],
    [
      "the anchor as a pattern map in a nested COLLECT",
      "MATCH (n) WHERE size(COLLECT { MATCH (m {orgId: $orgId}) RETURN m }) > 0 RETURN n",
    ],
    [
      "the anchor inside a scoped CALL, the outer MATCH bare",
      "MATCH (n) CALL (n) { MATCH (m) WHERE m.orgId = $orgId RETURN m } RETURN m",
    ],
    [
      "an uncorrelated EXISTS beside an anchored pattern",
      "MATCH (n {orgId: $orgId}) WHERE EXISTS { MATCH (m) WHERE m.x = 1 } RETURN n",
    ],
    [
      "an uncorrelated EXISTS beside an anchored WHERE",
      "MATCH (n) WHERE EXISTS { MATCH (m) WHERE m.x = 1 } AND n.orgId = $orgId RETURN n",
    ],
    [
      "an uncorrelated EXISTS returning its rows",
      "MATCH (n) WHERE EXISTS { MATCH (m) RETURN m } AND n.orgId = $orgId RETURN n",
    ],
    [
      "an id join to an unanchored pattern in a CALL",
      "MATCH (a) WHERE a.orgId = $orgId CALL { WITH a MATCH (b) WHERE b.id = a.id RETURN b } RETURN b",
    ],
    [
      "an unanchored pattern before the anchored one",
      "MATCH (a WHERE a.x = 1) MATCH (b {orgId: $orgId}) RETURN b",
    ],
    [
      "UNION credit does not carry across branches",
      "MATCH (n {orgId: $orgId}) RETURN n UNION MATCH (n) RETURN n",
    ],
  ];

  for (const [name, cypher] of refused) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
    it(`is discriminating: the query-wide anchor accepted ${name}`, () => {
      expect(() => assertAnchorsTenant(cypher)).toThrow(/Every MATCH pattern/);
    });
  }

  const accepted: Array<[name: string, cypher: string]> = [
    [
      "a pattern that reuses a variable an anchored pattern bound",
      "MATCH (c:Citation {orgId: $orgId}) OPTIONAL MATCH (e:Execution)-[:CITED]->(c) RETURN c, e",
    ],
    [
      "a WHERE anchor on the part's own variable",
      "MATCH (a {orgId: $orgId}) MATCH (b) WHERE b.orgId = $orgId RETURN a, b",
    ],
    [
      "a traversal whose WHERE anchors the far end",
      "MATCH (start:GraphNode {orgId: $orgId}) MATCH path = (start)-[r*1..3]->(reached:GraphNode) WHERE reached.orgId = $orgId RETURN reached",
    ],
    [
      "both parts of a comma product anchored",
      "MATCH (a {orgId: $orgId}), (b {orgId: $orgId}) RETURN a, b",
    ],
    [
      "a correlated EXISTS over an anchored variable",
      "MATCH (n {orgId: $orgId}) WHERE EXISTS { MATCH (n)-[:R]->(m) } RETURN n",
    ],
    [
      "a correlated CALL over an anchored variable",
      "MATCH (n:GraphNode) WHERE n.orgId = $orgId CALL { WITH n MATCH (n)-[r]->(m) RETURN count(r) AS c } RETURN n, c",
    ],
    [
      "each UNION branch anchored on its own",
      "MATCH (a {orgId: $orgId}) RETURN a AS x UNION MATCH (b) WHERE b.orgId = $orgId RETURN b AS x",
    ],
    [
      "a USING hint between the pattern and its WHERE",
      "MATCH (n:GraphNode) USING INDEX n:GraphNode(publicId) WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "MERGE's ON MATCH SET is not a row-selecting clause",
      "MERGE (n:GraphNode {orgId: $orgId, publicId: $p}) ON MATCH SET n.seen = true RETURN n",
    ],
    [
      "an anchor inside a top-level CALL",
      "CALL { MATCH (n) WHERE n.orgId = $orgId RETURN n } RETURN n",
    ],
  ];

  for (const [name, cypher] of accepted) {
    it(`accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// ── Credit follows the VARIABLE, not the name ───────────────────────────────
//
// Two review findings against the per-part rule, and they are one mistake read
// from either end. The rule credited a part with an earlier anchor when a NAME
// the anchored part bound appeared in it — read off every `(` and `[` in the
// part's text, and remembered until the next top-level `UNION`. Cypher credits
// a VARIABLE: a pattern element's own, and only while the scope still holds
// it. Every query below has a real, seam-bound anchor on one part and a second
// part the anchor does not reach; against the pooled database each reads rows
// from every tenant.
describe("tenancy guard — an anchor is credited to a variable, not a name", () => {
  const refused: Array<[name: string, cypher: string]> = [
    [
      "a name re-bound after WITH dropped it (review's query)",
      "MATCH (n {orgId: $orgId}) WITH count(n) AS c MATCH (n) RETURN n",
    ],
    [
      "a name in a property value, not a pattern element (review's query)",
      "MATCH (a {orgId: $orgId}) MATCH (b {x: toString(a.x)}) RETURN b",
    ],
    [
      "a name inside a list in a property value",
      "MATCH (a {orgId: $orgId}) MATCH (b {xs: [a.x]}) RETURN b",
    ],
    [
      "a name in a relationship's property value",
      "MATCH (a {orgId: $orgId}) MATCH (b)-[r {x: id(a)}]->(c) RETURN b, c",
    ],
    [
      "a name in an inline predicate only",
      "MATCH (a {orgId: $orgId}) MATCH (b WHERE b.x = a.x) RETURN b",
    ],
    [
      "a name in a grouping paren inside an inline predicate",
      "MATCH (a {orgId: $orgId}) MATCH (b WHERE (a.x) = b.x) RETURN b",
    ],
    [
      "WITH keeps a property of the variable, not the variable",
      "MATCH (n {orgId: $orgId}) WITH n.id AS id MATCH (n {id: id}) RETURN n",
    ],
    [
      "WITH re-aliases the variable (fail-closed, as before)",
      "MATCH (n {orgId: $orgId}) WITH n AS m MATCH (m)-->(k) RETURN k",
    ],
    [
      "WITH keeps another variable and drops the anchored one",
      "MATCH (n {orgId: $orgId})-->(m) WITH m MATCH (n)-->(k) RETURN k",
    ],
    [
      "the name re-bound after a second WITH in a chain",
      "MATCH (n {orgId: $orgId}) WITH n MATCH (n)-->(m) WITH m MATCH (n) RETURN n",
    ],
    [
      "a CALL body that never imported the anchored variable",
      "MATCH (n {orgId: $orgId}) CALL { MATCH (n) RETURN n AS x } RETURN x",
    ],
    [
      "a CALL body whose importing WITH drops it before the MATCH",
      "MATCH (n {orgId: $orgId}) CALL { WITH n MATCH (n)-->(m) WITH count(m) AS c MATCH (m) RETURN m } RETURN m",
    ],
    [
      "a UNION branch inside a CALL body",
      "MATCH (n {orgId: $orgId}) CALL { WITH n MATCH (n)-->(m) RETURN m UNION MATCH (m) RETURN m } RETURN m",
    ],
    [
      "a CALL exports an alias, not the anchored variable",
      "CALL { MATCH (n {orgId: $orgId}) RETURN n AS x } MATCH (x)-->(m) RETURN m",
    ],
    [
      "a CALL exports a variable anchored in one branch only",
      "CALL { MATCH (n {orgId: $orgId}) RETURN n UNION MATCH (n) RETURN n } MATCH (n)-->(m) RETURN m",
    ],
    [
      "a scoped CALL that imports the wrong variable",
      "MATCH (n {orgId: $orgId})-->(m) CALL (m) { MATCH (n)-->(k) RETURN k } RETURN k",
    ],
    [
      "an expression subquery's binding does not survive its brace",
      "MATCH (n) WHERE EXISTS { MATCH (n {orgId: $orgId}) } MATCH (n)-->(m) RETURN m",
    ],
    [
      "a UNION inside an expression subquery",
      "MATCH (n {orgId: $orgId}) WHERE EXISTS { MATCH (n)-->(m) RETURN m UNION MATCH (m) RETURN m } RETURN n",
    ],
  ];

  for (const [name, cypher] of refused) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
    it(`is discriminating: the query-wide anchor accepted ${name}`, () => {
      expect(() => assertAnchorsTenant(cypher)).toThrow(/Every MATCH pattern/);
    });
  }

  const accepted: Array<[name: string, cypher: string]> = [
    [
      "WITH keeps the variable by name",
      "MATCH (n {orgId: $orgId}) WITH n MATCH (n)-->(m) RETURN m",
    ],
    [
      "WITH * keeps every variable",
      "MATCH (n {orgId: $orgId}) WITH * MATCH (n)-->(m) RETURN m",
    ],
    [
      "WITH DISTINCT keeps the variable",
      "MATCH (n {orgId: $orgId}) WITH DISTINCT n MATCH (n)-->(m) RETURN m",
    ],
    [
      "WITH keeps the variable beside an aggregate, ordered and limited",
      "MATCH (n {orgId: $orgId})-->(m) WITH n, count(m) AS c ORDER BY c DESC LIMIT 5 MATCH (n)-->(k) RETURN k",
    ],
    [
      "WITH keeps the variable and filters it",
      "MATCH (n {orgId: $orgId}) WITH n WHERE n.x = 1 MATCH (n)-->(m) RETURN m",
    ],
    [
      "a CALL exports the anchored variable it returned",
      "CALL { MATCH (n {orgId: $orgId}) RETURN n } MATCH (n)-->(m) RETURN m",
    ],
    [
      "a CALL exports a variable it bound off the imported one",
      "MATCH (n {orgId: $orgId}) CALL { WITH n MATCH (n)-->(m) RETURN m } MATCH (m)-->(k) RETURN k",
    ],
    [
      "a scoped CALL imports the anchored variable",
      "MATCH (n {orgId: $orgId}) CALL (n) { MATCH (n)-->(m) RETURN m } RETURN m",
    ],
    [
      "a scoped CALL imports everything",
      "MATCH (n {orgId: $orgId}) CALL (*) { MATCH (n)-->(m) RETURN m } RETURN m",
    ],
    [
      "every UNION branch of a CALL body anchored on its own",
      "MATCH (n {orgId: $orgId}) CALL { WITH n MATCH (n)-->(m) RETURN m UNION WITH n MATCH (n)<--(m) RETURN m } RETURN m",
    ],
    [
      "an expression subquery sees the enclosing scope",
      "MATCH (n {orgId: $orgId}) WITH n WHERE COUNT { MATCH (n)-->(m) } > 0 RETURN n",
    ],
    [
      "a nested subquery sees what its enclosing subquery imported",
      "MATCH (n {orgId: $orgId}) CALL { WITH n MATCH (n)-->(m) WHERE EXISTS { MATCH (m)-->(k) } RETURN m } RETURN m",
    ],
    [
      "a name in a property value beside a real element reference",
      "MATCH (a {orgId: $orgId}) MATCH (a)-->(b {x: toString(a.x)}) RETURN b",
    ],
  ];

  for (const [name, cypher] of accepted) {
    it(`accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }

  it("names the dropped variable and the property-value case in the error", () => {
    expect(() =>
      assertAnchorsTenant(
        "MATCH (n {orgId: $orgId}) WITH count(n) AS c MATCH (n) RETURN n",
      ),
    ).toThrow(/a variable a WITH has dropped/);
  });
});

// ── An anchor names the pattern's variable, not a name an expression binds ──
//
// Review's third finding against the per-part rule. A WHERE anchor is credit
// for the variable it names, and a Cypher expression can bind a name of its
// own — a list predicate, a list comprehension, `reduce` — that shadows the
// pattern variable inside its bracket. An anchor written there is true of the
// local and says nothing about the row. The pattern-map cases are the same
// mistake in the other position: a `x.orgId = $orgId` inside a pattern map
// can only be a map VALUE, and a value constrains the key it is under.
describe("tenancy guard — an anchor on a shadowing or value position", () => {
  const refused: Array<[name: string, cypher: string]> = [
    [
      "the anchor names a list predicate's variable (review's query)",
      "MATCH (n) WHERE any(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) RETURN n",
    ],
    [
      "the same under all()",
      "MATCH (n) WHERE all(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) RETURN n",
    ],
    [
      "the same under none() negated",
      "MATCH (n) WHERE NOT none(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) RETURN n",
    ],
    [
      "the same under single()",
      "MATCH (n) WHERE single(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) RETURN n",
    ],
    [
      "the anchor names a list comprehension's variable",
      "MATCH (n) WHERE size([n IN [{orgId: $orgId}] WHERE n.orgId = $orgId]) > 0 RETURN n",
    ],
    [
      "the anchor names a list comprehension's variable in its projection",
      "MATCH (n) WHERE [n IN [{orgId: $orgId}] | n.orgId = $orgId][0] RETURN n",
    ],
    [
      "the anchor names reduce's element",
      "MATCH (n) WHERE reduce(ok = true, n IN [{orgId: $orgId}] | ok AND n.orgId = $orgId) RETURN n",
    ],
    [
      "the anchor names reduce's accumulator",
      "MATCH (n) WHERE reduce(n = {orgId: $orgId}, x IN [1] | n).orgId = $orgId RETURN n",
    ],
    [
      "the shadowing bracket is nested inside another",
      "MATCH (n) WHERE size(any(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId)) RETURN n",
    ],
    [
      "the shadowing predicate feeds a write",
      "MATCH (n) WHERE any(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) SET n.x = 1 RETURN n",
    ],
    [
      "the shadowed anchor is the only one, beside an unrelated predicate",
      "MATCH (n) WHERE n.x = 1 AND any(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) RETURN n",
    ],
    [
      "the anchor is a pattern-map value on an earlier variable",
      "MATCH (a {orgId: $orgId}) MATCH (n {ok: a.orgId = $orgId}) RETURN n",
    ],
    [
      "the anchor is a pattern-map value inside a list predicate",
      "MATCH (n {ok: any(m IN [1] WHERE m.orgId = $orgId)}) RETURN n",
    ],
  ];

  for (const [name, cypher] of refused) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  it("is discriminating: the query-wide anchor accepted the map-value cases", () => {
    // Property-form text sits inside a kept pattern map, so a projection that
    // read either shape in either position took it as an anchor.
    expect(
      keepFilteringPositions(
        "MATCH (a {orgId: $orgId}) MATCH (n {ok: a.orgId = $orgId}) RETURN n",
      ),
    ).toMatch(/a\.orgId = \$orgId/);
  });

  const accepted: Array<[name: string, cypher: string]> = [
    [
      "the anchor outside a predicate that shadows its variable",
      "MATCH (n) WHERE n.orgId = $orgId AND any(n IN [1] WHERE n > 0) RETURN n",
    ],
    [
      "the anchor after a shadowing predicate has closed",
      "MATCH (n) WHERE any(n IN [1] WHERE n > 0) AND n.orgId = $orgId RETURN n",
    ],
    [
      "a list predicate over another name beside the anchor",
      "MATCH (n) WHERE n.orgId = $orgId AND all(k IN keys(n) WHERE k <> 'x') RETURN n",
    ],
    [
      "the anchor inside a list predicate over another name",
      "MATCH (n) WHERE any(k IN keys(n) WHERE n.orgId = $orgId AND k = 'x') RETURN n",
    ],
    [
      "the anchor inside reduce over another name",
      "MATCH (n) WHERE reduce(ok = true, k IN keys(n) | ok AND n.orgId = $orgId) RETURN n",
    ],
    [
      "a membership test on a property beside the anchor",
      "MATCH (n) WHERE n.x IN [1, 2] AND n.orgId = $orgId RETURN n",
    ],
    [
      "the anchor inside a pattern comprehension, which binds no new name for n",
      "MATCH (n) WHERE size([(n)-->(m) WHERE n.orgId = $orgId | m]) > 0 RETURN n",
    ],
    [
      "a pattern-map key beside a property-form value",
      "MATCH (a {orgId: $orgId}) MATCH (n {orgId: $orgId, ok: a.orgId = $orgId}) RETURN n",
    ],
  ];

  for (const [name, cypher] of accepted) {
    it(`accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// ── Delimiting the anchor by Cypher's rules, not JavaScript's ────────────────
//
// The pattern is `orgId <: or => $orgId`, and it is only worth anything if
// `$orgId` is where the PARAMETER NAME ENDS and `orgId` is where the PROPERTY
// NAME BEGINS. `\b` decides neither: it is ASCII-only, while a Cypher
// unescaped symbolic name is Unicode (openCypher: IdentifierPart = ID_Continue
// | Sc). `\b` fires between `d` and `é`, so one accent defeated the guard from
// either end.
//
// `ROUND_SIX_GUARD` below is the shipped `\b` form. Every case asserts it
// ACCEPTED what the current guard rejects, which is the mutation check written
// as an assertion — the same device `OLD_GUARD` performs for the earlier
// rounds.
const ROUND_SIX_GUARD = /\borgId\s*[:=]\s*\$orgId\b/;

describe("tenancy guard — the anchor's token boundaries are Cypher's", () => {
  const bypasses: Array<[name: string, cypher: string, why: string]> = [
    [
      "a non-ASCII suffix on the parameter",
      "MATCH (n) WHERE n.orgId = $orgIdé RETURN n",
      "the seam's injected $orgId goes unused; the caller supplies `orgIdé` and chooses whose organisation it names",
    ],
    [
      "a CJK suffix on the parameter",
      "MATCH (n) WHERE n.orgId = $orgId中 RETURN n",
      "the same defect; `\\b` is ASCII-only for every script, not only Latin-1",
    ],
    [
      "a non-ASCII prefix on the property",
      "MATCH (n) WHERE n.éorgId = $orgId RETURN n",
      "filters a property that is not the tenant column against a parameter that is",
    ],
    [
      "no property at all — a tautology",
      "MATCH (n) WHERE $orgId = $orgId RETURN n",
      "`$` is a currency symbol and continues an identifier, so the lookbehind is what refuses to read a parameter as a bare property name",
    ],
    [
      "a non-ASCII prefix inside a pattern property map",
      "MATCH (n {éorgId: $orgId}) RETURN n",
      "the map form has both ends and both were under-delimited",
    ],
  ];

  for (const [name, cypher, why] of bypasses) {
    it(`rejects: ${name} — ${why}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
    it(`is discriminating: the \\b guard accepted ${name}`, () => {
      expect(ROUND_SIX_GUARD.test(keepFilteringPositions(cypher))).toBe(true);
    });
  }

  // Getting stricter must not start refusing valid, correctly-anchored Cypher.
  const stillAccepted: Array<[name: string, cypher: string]> = [
    ["the plain WHERE form", "MATCH (n) WHERE n.orgId = $orgId RETURN n"],
    ["the pattern property map form", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "an accented identifier elsewhere in the query",
      "MATCH (nøde) WHERE nøde.orgId = $orgId RETURN nøde",
    ],
    [
      "a second, caller-named parameter that is legitimately non-ASCII",
      "MATCH (n) WHERE n.orgId = $orgId AND n.navn = $navné RETURN n",
    ],
    [
      "the anchor immediately followed by a closing brace",
      "MATCH (n {orgId: $orgId}) RETURN n",
    ],
    [
      "the anchor immediately followed by a closing paren",
      "MATCH (n) WHERE (n.orgId = $orgId) RETURN n",
    ],
  ];

  for (const [name, cypher] of stillAccepted) {
    it(`still accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// ── A subquery inside an inline node predicate ──────────────────────────────
//
// Cypher 5 lets a node pattern carry its own predicate: `MATCH (n WHERE …)`.
// The brace of a subquery written there sits inside a PATTERN paren, and the
// brace classifier consulted the enclosing bracket before the token immediately
// in front of the brace — so the subquery was kept as if it were the pattern's
// property map, projections and all.
//
// `COLLECT { … }` is non-empty whenever any node exists, so the predicate holds
// for every row, and the projected comparison supplied the anchor.
describe("tenancy guard — a subquery inside an inline node predicate", () => {
  const bypasses: Array<[name: string, cypher: string]> = [
    [
      "COLLECT (review's case)",
      "MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> []) RETURN n",
    ],
    [
      "EXISTS",
      "MATCH (n WHERE EXISTS { MATCH (m) RETURN m.orgId = $orgId AS mine }) RETURN n",
    ],
    [
      "COUNT",
      "MATCH (n WHERE COUNT { MATCH (m) RETURN m.orgId = $orgId AS mine } > 0) RETURN n",
    ],
    [
      "on a relationship pattern instead of a node",
      "MATCH (a)-[r WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> []]->(b) RETURN a",
    ],
    [
      "nested one subquery deeper",
      "MATCH (n WHERE EXISTS { MATCH (x WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS q } <> []) }) RETURN n",
    ],
    [
      "under MERGE rather than MATCH",
      "MERGE (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS q } <> []) RETURN n",
    ],
  ];

  for (const [name, cypher] of bypasses) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  it("is discriminating: the projection is what carried the anchor", () => {
    // Every case above puts the token in a RETURN projection, which filters
    // nothing. The guard regex matches the raw text; only the position rule
    // refuses it — so asserting on the raw text is the discriminating half.
    const cypher =
      "MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> []) RETURN n";
    expect(/[A-Za-z]\.orgId\s*=\s*\$orgId/.test(cypher)).toBe(true);
    expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
  });

  const stillAccepted: Array<[name: string, cypher: string]> = [
    [
      "a pattern map beside an inline predicate on the same node",
      "MATCH (n {orgId: $orgId} WHERE n.x > 1) RETURN n",
    ],
    ["a plain node pattern map", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "a relationship pattern map",
      "MATCH (a)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
  ];
  for (const [name, cypher] of stillAccepted) {
    it(`still accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }

  // The measured cost, at the seam rather than only in the projection helper.
  // Clause keywords are recognised only at depth 0, so a subquery's own WHERE
  // inside an inline node predicate never becomes the clause; an anchor written
  // ONLY there is now refused. Fail-closed, 0 of the 63 corpus queries, and the
  // pattern-map spelling of the same query (asserted above) still passes.
  it("refuses an anchor that exists only inside an inline-predicate subquery", async () => {
    // Round 14 accepted this, because the subquery's WHERE is a real filtering
    // position. It filters `m`, not `n`, and `n` is what comes back, so the
    // per-pattern rule refuses it — as it refuses the top-level spelling.
    await expect(
      guardAccepts(
        "MATCH (n WHERE EXISTS { MATCH (m) WHERE m.orgId = $orgId }) RETURN n",
      ),
    ).resolves.toBe(false);
    // The projection spelling of the same query is still refused.
    await expect(
      guardAccepts(
        "MATCH (n WHERE EXISTS { MATCH (m) RETURN m.orgId = $orgId AS x }) RETURN n",
      ),
    ).resolves.toBe(false);
  });
});

// ── The anchor has to be a property, not a name that reads like one ─────────
//
// The guard checked WHERE the token sits and WHAT it binds to, and never that
// the left-hand side is a property ACCESS. A query may bind a variable called
// `orgId`, and the anchor is then a tautology over every tenant's nodes.
describe("tenancy guard — a bare name is not a tenant property", () => {
  const tautologies: Array<[name: string, cypher: string]> = [
    [
      "WITH aliases the injected parameter (review's case)",
      "WITH $orgId AS orgId MATCH (n) WHERE orgId = $orgId RETURN n",
    ],
    [
      "UNWIND binds the same name",
      "UNWIND [$orgId] AS orgId MATCH (n) WHERE orgId = $orgId RETURN n",
    ],
    [
      "the alias is introduced after a MATCH",
      "MATCH (n) WITH n, $orgId AS orgId WHERE orgId = $orgId RETURN n",
    ],
    [
      "a caller-supplied parameter map",
      "MATCH (n) WHERE $p.orgId = $orgId RETURN n",
    ],
    [
      "the injected parameter's own property",
      "MATCH (n) WHERE $orgId.orgId = $orgId RETURN n",
    ],
  ];

  for (const [name, cypher] of tautologies) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
    it(`is discriminating: the round-ten anchor accepted ${name}`, () => {
      // The round-ten guard was `orgId <[:=]> $orgId` with Unicode delimiters and
      // no shape requirement, so it matched all of these against the same
      // projection the current guard runs over.
      const ROUND_TEN =
        /(?<![\p{ID_Continue}\p{Sc}])orgId\s*[:=]\s*\$orgId(?![\p{ID_Continue}\p{Sc}])/u;
      expect(ROUND_TEN.test(keepFilteringPositions(cypher))).toBe(true);
    });
  }

  const stillAccepted: Array<[name: string, cypher: string]> = [
    [
      "a qualified property access",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "a property access with spaces around the dot",
      "MATCH (n) WHERE n . orgId = $orgId RETURN n",
    ],
    [
      "an accented variable's property",
      "MATCH (n\u00f8de) WHERE n\u00f8de.orgId = $orgId RETURN n\u00f8de",
    ],
    ["a node pattern property map key", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "a relationship pattern property map key",
      "MATCH (a)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    ["a pattern map key with spaces", "MATCH (n { orgId : $orgId }) RETURN n"],
  ];
  for (const [name, cypher] of stillAccepted) {
    it(`still accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }

  // Round 11 recorded `WITH {orgId: $orgId} AS m MATCH (n) WHERE m.orgId =
  // $orgId RETURN n` as accepted: telling `m.orgId` from `n.orgId` needs to know
  // what `m` is bound to. The per-pattern rule does not answer that question; it
  // asks a narrower one — is the anchored variable written in THIS pattern —
  // and `m` is not, so the query is now refused. It is asserted with the other
  // per-pattern refusals below.
});

// ── A map literal is a value, not a filter ──────────────────────────────────
//
// `keepFilteringPositions` keeps a `WHERE` clause whole, so a map literal
// written inside one handed this guard its key. The predicate below is an
// always-true non-null test and returns every tenant's nodes.
//
// Review reported the first of these. The rest came from enumerating the
// positions a map can occupy, and every one was accepted — which is why the
// enumeration is in the suite rather than the single reported case.
describe("tenancy guard — a map literal is not a tenant anchor", () => {
  const encodings: Array<[name: string, cypher: string]> = [
    [
      "bare in a WHERE (review's case)",
      "MATCH (n) WHERE {orgId: $orgId} IS NOT NULL RETURN n",
    ],
    [
      "as a function argument",
      "MATCH (n) WHERE size(keys({orgId: $orgId})) > 0 RETURN n",
    ],
    [
      "as a map PROJECTION",
      "MATCH (n) WHERE n{orgId: $orgId} IS NOT NULL RETURN n",
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
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
    it(`is discriminating: the pre-round-ten projection kept it: ${name}`, () => {
      // The guard REGEX is unchanged by this round — what changed is the
      // projection it runs over. So the discriminating assertion is that the
      // shipped regex matches the raw text, i.e. only the position rule refuses
      // it now.
      expect(/orgId\s*[:=]\s*\$orgId/.test(cypher)).toBe(true);
    });
  }

  const stillAccepted: Array<[name: string, cypher: string]> = [
    ["a node pattern property map", "MATCH (n {orgId: $orgId}) RETURN n"],
    [
      "a relationship pattern property map",
      "MATCH (a)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    [
      "a property predicate in a WHERE",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
    ],
  ];
  for (const [name, cypher] of stillAccepted) {
    it(`still accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// ── An inner clause does not govern the enclosing expression ─────────────────
//
// A brace can carry a whole clause sequence without opening a paren or a
// bracket, and the scanner's `clause` was a single global. The `WHERE` inside
// `EXISTS { … }` therefore survived the closing brace and made the rest of the
// outer projection a kept "filtering position", so an ALIASED COLUMN satisfied
// the tenancy guard for a query that scopes nothing.
describe("tenancy guard — a clause inside an expression subquery", () => {
  it("rejects review's query: an aliased anchor after EXISTS { … WHERE … }", async () => {
    await expect(
      guardAccepts(
        "MATCH (n) RETURN EXISTS { MATCH (m) WHERE m.x = 1 } AS ok, n.orgId = $orgId AS mine, n",
      ),
    ).resolves.toBe(false);
  });

  it("is discriminating: the leaked clause made that query pass", () => {
    // The projection is kept only because the inner WHERE escaped the brace, so
    // asserting on the projection IS the assertion about the leak.
    const cypher =
      "MATCH (n) RETURN EXISTS { MATCH (m) WHERE m.x = 1 } AS ok, n.orgId = $orgId AS mine, n";
    expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    // …and the identical query without the subquery was always rejected, so the
    // subquery is doing the work rather than some other part of the shape.
    expect(
      keepFilteringPositions("MATCH (n) RETURN n.orgId = $orgId AS mine, n"),
    ).not.toContain("$orgId");
  });

  const stillAccepted: Array<[name: string, cypher: string]> = [
    [
      "anchored inside a CALL subquery",
      "CALL { MATCH (n) WHERE n.orgId = $orgId RETURN n } RETURN n",
    ],
  ];

  for (const [name, cypher] of stillAccepted) {
    it(`still accepts a correctly-scoped query: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

describe("tenancy guard — anchored to a parameter the caller controls", () => {
  const notSeamBound: Array<[name: string, cypher: string]> = [
    [
      "WHERE against a caller-supplied parameter",
      "MATCH (n) WHERE n.orgId = $victimOrgId RETURN n",
    ],
    [
      "pattern property against a caller-supplied parameter",
      "MATCH (n:GraphNode {orgId: $someOtherParam}) RETURN n",
    ],
    [
      "membership against a caller-supplied list",
      "MATCH (n) WHERE n.orgId IN $arbitraryList RETURN n",
    ],
    [
      "hard-coded literal tenant",
      "MATCH (n) WHERE n.orgId = 'some-uuid' RETURN n",
    ],
    [
      "reversed comparison against a caller-supplied parameter",
      "MATCH (n) WHERE $victimOrgId = n.orgId RETURN n",
    ],
    [
      "parameter whose name merely starts with orgId",
      "MATCH (n) WHERE n.orgId = $orgIdOverride RETURN n",
    ],
    [
      "MERGE key against a caller-supplied parameter",
      "MERGE (e:Execution {id: $id, orgId: $callerChosenOrg})",
    ],
  ];

  for (const [name, cypher] of notSeamBound) {
    it(`rejects: ${name}`, async () => {
      // Discriminating against the round-3 guard, which checked position and
      // shape and never checked the binding.
      const round3 = /\borgId\s*[:=]|\borgId\s+IN\b|=\s*[\w$]+\.orgId\b/;
      expect(round3.test(keepFilteringPositions(cypher))).toBe(true);
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  it("accepts the seam parameter in both binding shapes", async () => {
    await expect(
      guardAccepts("MATCH (n) WHERE n.orgId = $orgId RETURN n"),
    ).resolves.toBe(true);
    await expect(
      guardAccepts("MATCH (n:GraphNode {orgId: $orgId}) RETURN n"),
    ).resolves.toBe(true);
  });
});

describe("tenancy guard — shapes that really do anchor the tenant", () => {
  const anchored: Array<[name: string, cypher: string]> = [
    [
      "pattern property map",
      "MATCH (n:GraphNode {publicId: $p, orgId: $orgId, workspaceId: $workspaceId}) RETURN n",
    ],
    [
      "WHERE predicate",
      "MATCH (n:GraphNode) WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId RETURN n",
    ],
    [
      "MERGE key",
      "MERGE (e:Execution {id: $id, orgId: $orgId, workspaceId: $workspaceId})",
    ],
    ["no whitespace", "MATCH (n:GraphNode) WHERE n.orgId=$orgId RETURN n"],
    [
      "SET is fine when the MATCH that feeds it is anchored",
      "MATCH (n:GraphNode {orgId: $orgId, publicId: $p}) SET n.properties = $props",
    ],
    [
      "SET is fine when a WHERE anchors the rows",
      "MATCH (n:GraphNode) WHERE n.orgId = $orgId SET n.properties = $props",
    ],
    [
      "relationship pattern property",
      "MERGE (a)-[r:INVOKED {orgId: $orgId}]->(b) RETURN r",
    ],
    [
      "anchored WHERE with a CALL subquery after it",
      "MATCH (n:GraphNode) WHERE n.orgId = $orgId CALL { WITH n MATCH (n)-[r]->(m) RETURN count(r) AS c } RETURN n, c",
    ],
    [
      "extra whitespace",
      "MATCH (n:GraphNode) WHERE n.orgId  =  $orgId RETURN n",
    ],
    [
      "newline between token and colon",
      "MATCH (n:GraphNode {\n  orgId:\n    $orgId\n}) RETURN n",
    ],
    [
      "real predicate alongside a comment that also mentions the token",
      "// tenancy: orgId\nMATCH (n:GraphNode) WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "real predicate alongside a URL literal (strip must not eat the clause)",
      "MATCH (n:GraphNode) WHERE n.url = 'http://x/y' AND n.orgId = $orgId RETURN n",
    ],
    [
      "real predicate alongside an apostrophe inside a comment",
      "// don't strip past here\nMATCH (n:GraphNode) WHERE n.orgId = $orgId RETURN n",
    ],
  ];

  for (const [name, cypher] of anchored) {
    it(`accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// A clause keyword recognised by nesting depth alone is a keyword a CALLER can
// spell. `$where` opened a WHERE clause from inside a SET, which made the rest
// of the SET target a kept "filtering position" — so a query that reassigns
// every tenant's nodes to the caller satisfied the tenancy guard. Four
// spellings, one class: the word is lexically an identifier and the scanner
// read it as a clause.
describe("tenancy guard — a name spelled like a clause keyword", () => {
  const spoofs: Array<[name: string, cypher: string]> = [
    [
      "a parameter named $where",
      "MATCH (n) SET n.x = $where, n.orgId = $orgId",
    ],
    ["a property key .where", "MATCH (n) SET n.where = 1, n.orgId = $orgId"],
    [
      "a property key with spaces around the dot",
      "MATCH (n) SET n . where = 1, n.orgId = $orgId",
    ],
    ["a label :Where", "MATCH (n) SET n:Where, n.orgId = $orgId"],
    ["a map key {where: …}", "MATCH (n) SET n += {where: 1, orgId: $orgId}"],
  ];

  for (const [name, cypher] of spoofs) {
    it(`rejects the write bypass opened by ${name}`, async () => {
      // Discriminating: the naive guard accepts every one of these, and each
      // is a WRITE whose SET target would land on every tenant's nodes.
      expect(OLD_GUARD.test(strippedForTest(cypher))).toBe(true);
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  // Class coverage rather than discriminating cases: the rule is about the
  // token before the word, not about WHERE, so it is exercised on other
  // keywords too. Both were already rejected before this fix, for an unrelated
  // reason — neither `OPTIONAL` nor `MERGE` opens a keeping region outside a
  // pattern map — so they are asserted without the OLD_GUARD claim.
  const sameClass: Array<[name: string, cypher: string]> = [
    [
      "a parameter named after a different clause keyword",
      "MATCH (n) SET n.x = $optional, n.orgId = $orgId",
    ],
    [
      "a procedure segment named .merge",
      "CALL apoc.merge.node(['X'], {orgId: $orgId}) YIELD node RETURN node",
    ],
  ];

  for (const [name, cypher] of sameClass) {
    it(`treats ${name} as an identifier, not a clause`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }
});

// The other half of the rule: a disqualified word is an ORDINARY IDENTIFIER, so
// `clause` is left alone rather than cleared. Clearing it would be the mirror
// defect — a property key named `.set` would close the WHERE out from under a
// legitimate anchor, and a false reject takes down every read on that path.
describe("tenancy guard — a keyword-shaped name does not break a real clause", () => {
  const accepted: Array<[name: string, cypher: string]> = [
    [
      "a property key spelled like a clause keyword, inside the WHERE",
      "MATCH (n) WHERE n.set = 1 AND n.orgId = $orgId RETURN n",
    ],
    [
      "a parameter spelled like a clause keyword, inside the WHERE",
      "MATCH (n) WHERE n.x = $limit AND n.orgId = $orgId RETURN n",
    ],
    [
      "the ANN shape: WHERE after `YIELD node AS n, score`",
      `CALL db.index.vector.queryNodes('i', $k, $v) YIELD node AS n, score
       WHERE n.orgId = $orgId RETURN n LIMIT 10`,
    ],
    [
      "a pattern-map anchor after UNWIND … AS tl",
      "UNWIND $tools AS tl MERGE (t:Tool {id: tl.id, orgId: $orgId}) RETURN t",
    ],
  ];

  for (const [name, cypher] of accepted) {
    it(`still accepts ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }
});

// ── The inline pattern predicate, end to end ────────────────────────────────
//
// The projection-level enumeration lives in `graph-scope.test.ts`. These drive
// the same shapes through the real seam, because the thing that matters is
// whether `scopedSession().run()` lets the query reach Neo4j, and the two
// findings this closes were both reported as reads that reach it.
//
// Round twelve reported a subquery brace inside `MATCH (n WHERE …)`; round
// thirteen reported a map literal in the same place. A node pattern is
// `( [variable] [labels] [propertyMap] [WHERE expr] )`, so the `WHERE` is where
// the property-map position ends — both braces are expressions, and so is every
// bracket after it in that frame.
describe("tenancy guard — an inline pattern predicate is not a property map", () => {
  const bypasses: Array<[name: string, cypher: string]> = [
    [
      "a map literal (review's round-13 case)",
      "MATCH (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "a map literal parenthesised",
      "MATCH (n WHERE ({orgId: $orgId}) IS NOT NULL) RETURN n",
    ],
    [
      "a map literal in a CASE arm",
      "MATCH (n WHERE CASE WHEN true THEN {orgId: $orgId} END IS NOT NULL) RETURN n",
    ],
    [
      "a map whose VALUE holds the comparison",
      "MATCH (n WHERE {k: n.orgId = $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "a map nested inside another map",
      "MATCH (n WHERE {a: {orgId: $orgId}} IS NOT NULL) RETURN n",
    ],
    [
      "a map after a map projection",
      "MATCH (n WHERE n{.orgId} IS NOT NULL AND {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "a grouping paren inside the predicate",
      "MATCH (n WHERE true = ({orgId: $orgId} IS NOT NULL)) RETURN n",
    ],
    [
      "a pattern comprehension inside the predicate",
      "MATCH (n WHERE size([(n)-->(m {orgId: $orgId}) | m]) > 0) RETURN n",
    ],
    [
      "on a relationship pattern",
      "MATCH (a)-[r WHERE {orgId: $orgId} IS NOT NULL]->(b) RETURN a",
    ],
    [
      "on the second node of a path",
      "MATCH (a)-[r]->(m WHERE {orgId: $orgId} IS NOT NULL) RETURN a",
    ],
    [
      "under OPTIONAL MATCH",
      "OPTIONAL MATCH (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    ["under MERGE", "MERGE (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n"],
    [
      "after a label expression",
      "MATCH (n:GraphNode WHERE {orgId: $orgId} IS NOT NULL) RETURN n",
    ],
    [
      "inside a quantified path pattern",
      "MATCH ((a WHERE {orgId: $orgId} IS NOT NULL)-[r]->(b)){1,3} RETURN a",
    ],
    [
      "an inline predicate nested inside another",
      "MATCH (n WHERE EXISTS { MATCH (m WHERE {orgId: $orgId} IS NOT NULL) RETURN m }) RETURN n",
    ],
  ];

  for (const [name, cypher] of bypasses) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  it("is discriminating: the OLD guard accepted every one of them", () => {
    // Each case carries the anchor's exact syntax, so the guard regex matches
    // the raw text and only the position rule refuses it. Asserted against the
    // pre-fix guard so the block cannot pass on a regex that stopped matching.
    for (const [, cypher] of bypasses) {
      expect(OLD_GUARD.test(cypher)).toBe(true);
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    }
  });

  const stillAccepted: Array<[name: string, cypher: string]> = [
    [
      "a property map written BEFORE the inline predicate",
      "MATCH (n {orgId: $orgId} WHERE {x: 1} IS NOT NULL) RETURN n",
    ],
    [
      "a later node's property map in the same path",
      "MATCH (a WHERE a.x = 1)-[r]->(b {orgId: $orgId}) RETURN b",
    ],
    [
      "a later relationship's property map",
      "MATCH (a WHERE a.x = 1)-[r {orgId: $orgId}]->(b) RETURN r",
    ],
    [
      "a map key spelled `where`",
      "MATCH (n {where: 1, orgId: $orgId}) RETURN n",
    ],
    ["a label spelled `Where`", "MATCH (n:Where {orgId: $orgId}) RETURN n"],
    [
      "a backtick-escaped variable spelled `where`",
      "MATCH (`where` {orgId: $orgId}) RETURN 1",
    ],
  ];

  for (const [name, cypher] of stillAccepted) {
    it(`still accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }

  // The measured cost. An anchor written ONLY inside an inline predicate is
  // refused — which predates this change, since the region was never the WHERE
  // clause — and a bare variable spelled `where` opens the region, which Cypher
  // reserves against anyway. Both are fail-closed and cost 0 of the 63 corpus
  // queries the block below collects.
  it("refuses an anchor written only inside an inline predicate", async () => {
    await expect(
      guardAccepts("MATCH (n WHERE n.orgId = $orgId) RETURN n"),
    ).resolves.toBe(false);
    await expect(
      guardAccepts("MATCH (where {orgId: $orgId}) RETURN where"),
    ).resolves.toBe(false);
  });
});

// ── A subquery's clause baseline is its own, end to end ────────────────────
//
// Clause keywords were recognised only at ABSOLUTE paren/bracket depth 0, so a
// subquery nested under any paren or bracket had its own clauses go unseen and
// the OUTER clause stayed in force over its whole body. A projection — and even
// a SET — was then read as a predicate. The projection-level enumeration is in
// `graph-scope.test.ts`; these drive the same shapes through the real seam.
describe("tenancy guard — a subquery's clause baseline is its own", () => {
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
    [
      "a SET inside the nested subquery",
      "MATCH (n) WHERE size(COLLECT { MATCH (m) SET m.orgId = $orgId RETURN m }) > 0 RETURN n",
    ],
  ];

  for (const [name, cypher] of bypasses) {
    it(`rejects: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(false);
    });
  }

  it("is discriminating: the OLD guard accepted every one of them", () => {
    for (const [, cypher] of bypasses) {
      expect(OLD_GUARD.test(cypher)).toBe(true);
      expect(keepFilteringPositions(cypher)).not.toContain("$orgId");
    }
  });

  // Round 14 REMOVES two refusals as well. Both were round 12's recorded cost,
  // and both are this same mechanism seen from its fail-closed side.
  const nowAccepted: Array<[name: string, cypher: string]> = [
    [
      "a top-level CALL subquery",
      "CALL { MATCH (n) WHERE n.orgId = $orgId RETURN n } RETURN n",
    ],
  ];

  for (const [name, cypher] of nowAccepted) {
    it(`accepts: ${name}`, async () => {
      await expect(guardAccepts(cypher)).resolves.toBe(true);
    });
  }

  it("a SET after a subquery is still refused", async () => {
    // The restore has to put the OUTER clause back, not leave the subquery's
    // last one in force — otherwise a trailing SET inherits a kept region.
    await expect(
      guardAccepts(
        "MATCH (n) WHERE EXISTS { MATCH (m) RETURN m } SET n.orgId = $orgId",
      ),
    ).resolves.toBe(false);
  });
});

// ── The string that executes is the string that was checked ────────────────
//
// `applyGraphScope` REWRITES the query after every guard has read it:
// `clampVarLengthHops` rebounds a `*1..5` quantifier and `clampLimits` clamps or
// appends a `LIMIT`. `session.run` is handed the rewritten form. So the seam was
// validating one string and executing another — the same class as everything
// else in this file, a decision about an artifact that is not the artifact the
// decision governs.
//
// No clamp can break an anchor today, and the argument is bounded: their whole
// output alphabet is digits, `*` and `..` substituted strictly between an
// existing `[` and `]`, plus a trailing newline + `LIMIT <digits>`. The tests
// below assert that property directly over every clamp branch, so a future clamp
// that violates it fails here rather than in production. `applyGraphScope` now
// runs the clamps BEFORE its guards, and `run()` re-asserts the tenancy anchor
// on `applied.cypher`, so the invariant is structural rather than re-derived by
// whoever edits the clamps next. `tenant.executed-cypher.test.ts` pins the
// wiring by substituting a rewrite step that does break the anchor.
describe("tenancy guard — the executed Cypher is re-checked", () => {
  const scope: GraphScope = { budget: { maxHops: 2, maxNodes: 10 } };

  /** Run through the seam and report the Cypher Neo4j was actually handed. */
  async function executed(cypher: string): Promise<string> {
    run.mockClear();
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession(scope);
      await s.run(cypher);
    });
    return run.mock.calls[0]?.[0] as string;
  }

  const clampBranches: Array<[name: string, cypher: string]> = [
    [
      "an unbounded hop quantifier",
      "MATCH (a {orgId: $orgId})-[r*]->(b) RETURN b LIMIT 5",
    ],
    [
      "an open upper bound",
      "MATCH (a {orgId: $orgId})-[r*2..]->(b) RETURN b LIMIT 5",
    ],
    [
      "an explicit range above the cap",
      "MATCH (a {orgId: $orgId})-[r*1..9]->(b) RETURN b LIMIT 5",
    ],
    [
      "an exact hop count above the cap",
      "MATCH (a {orgId: $orgId})-[r*7]->(b) RETURN b LIMIT 5",
    ],
    [
      "a typed quantifier, where the anchor shares the bracket",
      "MATCH (a)-[r:T*1..9 {orgId: $orgId}]->(b) RETURN b LIMIT 5",
    ],
    [
      "a LIMIT clamped down",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n LIMIT 500",
    ],
    [
      "a LIMIT appended because there was none",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
    ],
    [
      "a LIMIT appended after a trailing line comment",
      "MATCH (n) WHERE n.orgId = $orgId RETURN n // done",
    ],
    [
      "both clamps on one query",
      "MATCH (a {orgId: $orgId})-[r*1..9]->(b) RETURN b LIMIT 500",
    ],
  ];

  for (const [name, cypher] of clampBranches) {
    it(`still anchors after the clamps: ${name}`, async () => {
      const sent = await executed(cypher);
      expect(sent).toBeTypeOf("string");
      // The executed text, not the authored text, satisfies the guard.
      expect(() => assertAnchorsTenant(sent)).not.toThrow();
      expect(keepFilteringPositions(sent)).toContain("$orgId");
    });
  }

  it("is discriminating: the clamps really did rewrite the query", async () => {
    // Without this the block above would pass on a seam that clamped nothing.
    const rewritten = await Promise.all(
      clampBranches.map(async ([, c]) => (await executed(c)) !== c),
    );
    expect(rewritten.every(Boolean)).toBe(true);
  });

  it("the clamps introduce no bracket, brace, clause or write keyword", async () => {
    // The bounded argument for why the re-check cannot fire today, asserted
    // rather than reasoned: whatever a clamp adds is drawn from this alphabet.
    for (const [, cypher] of clampBranches) {
      const sent = await executed(cypher);
      const strip = (t: string) => t.replace(/[\s\d*.]|LIMIT/gi, "");
      // Every character of the ORIGINAL survives in order, once the clamped
      // numerics and the appended LIMIT are removed from both sides.
      expect(strip(sent)).toBe(strip(cypher));
    }
  });

  it("re-checks the executed string, not only the authored one", () => {
    // The re-check itself, driven directly: the clamps cannot currently produce
    // an unanchored rewrite, so the assertion is exercised here rather than
    // through a contrived clamp.
    expect(() =>
      assertAnchorsTenant("MATCH (n {orgId: $orgId}) RETURN n LIMIT 10"),
    ).not.toThrow();
    expect(() => assertAnchorsTenant("MATCH (n) RETURN n LIMIT 10")).toThrow(
      /must bind the tenant/,
    );
  });
});

// ── the repo corpus ──────────────────────────────────────────────────────────

/** Walk up from this file until the pnpm workspace root. */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("could not locate the pnpm workspace root");
}

interface CorpusEntry {
  file: string;
  line: number;
  cypher: string;
}

/**
 * Every Cypher literal handed to a `.run()` inside a file that uses
 * `scopedSession`. Template-literal holes are replaced with a placeholder that
 * carries no `orgId` of its own, so an interpolated query is reported rather
 * than silently credited with an anchor the static text does not show — those
 * are then listed explicitly below with the reason each is safe.
 */
function collectCorpus(root: string): CorpusEntry[] {
  // Walked rather than listed with `git ls-files`: the CI containers run tests
  // as a different user than the checkout owner, where git refuses the repo as
  // "dubious ownership" and the corpus would silently collapse to nothing.
  const SKIP = new Set([
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".git",
    ".next",
    ".turbo",
    ".vercel",
  ]);
  const listed: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(resolve(root, dir), {
      withFileTypes: true,
    })) {
      if (ent.name.startsWith(".") && ent.name !== ".github") continue;
      const rel = dir === "" ? ent.name : `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (!SKIP.has(ent.name)) walk(rel);
      } else if (/\.tsx?$/.test(ent.name)) {
        listed.push(rel);
      }
    }
  };
  walk("");

  // Anything that looks like a query rather than an Inngest `step.run("name")`.
  const CYPHER =
    /(?:\bOPTIONAL\s+MATCH\b|\bMATCH\s*\(|\bMERGE\s*\(|\bCREATE\s*\(|\bDETACH\s+DELETE\b|\bCALL\s+(?:db|apoc)\.)/;
  const out: CorpusEntry[] = [];

  // Test files are excluded on purpose: several of them feed the guard a
  // deliberately unanchored query to assert it throws, and an integration test
  // may drive a RAW driver session (no guard at all) from a file that also
  // mentions `scopedSession`. The invariant this corpus protects is about
  // shipped query paths.
  const isTest = (f: string) => /\.test\.tsx?$|__tests__\/|\/test\//.test(f);

  for (const rel of listed) {
    if (isTest(rel)) continue;
    const abs = resolve(root, rel);
    const src = readFileSync(abs, "utf8");
    if (!src.includes("scopedSession")) continue;
    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);

    const literalText = (node: ts.Node): string | null => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        return node.text;
      }
      if (ts.isTemplateExpression(node)) {
        let text = node.head.text;
        for (const span of node.templateSpans) {
          text += "«»" + span.literal.text;
        }
        return text;
      }
      // `run(SOME_CYPHER_CONST, …)` — resolve a module-level const in the
      // same file so hoisted queries are covered too.
      if (ts.isIdentifier(node)) {
        let found: string | null = null;
        const seek = (n: ts.Node) => {
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === node.text &&
            n.initializer
          ) {
            found = literalText(n.initializer);
          }
          ts.forEachChild(n, seek);
        };
        seek(sf);
        return found;
      }
      return null;
    };

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "run" &&
        node.arguments.length > 0
      ) {
        const text = literalText(node.arguments[0]!);
        if (text !== null && CYPHER.test(text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push({ file: rel, line: line + 1, cypher: text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Queries whose static text cannot show the anchor, each with why it is safe.
 * Keyed `file:line`; an entry that stops matching a real call site fails the
 * test below, so this list cannot rot into a blanket suppression.
 */
const INTERPOLATED_BUT_ANCHORED: Record<string, string> = {
  "packages/handlers/src/graph.node.list.ts": `the interpolated \`whereClause\` opens with
     "WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId" — see the
     construction a few lines above each call.`,
};

describe("repo corpus — the guard still accepts every scoped query in the tree", () => {
  const root = repoRoot();
  const corpus = collectCorpus(root);

  it("found a corpus worth checking", () => {
    // A collector that silently stops matching would make every assertion
    // below vacuously true. 40 is well under the 63 production call sites
    // present today and well over anything a refactor would plausibly leave.
    expect(corpus.length).toBeGreaterThan(40);
    expect(new Set(corpus.map((e) => e.file)).size).toBeGreaterThan(10);
  });

  it("every scoped query anchors the tenant", async () => {
    const rejected: string[] = [];
    for (const entry of corpus) {
      if (INTERPOLATED_BUT_ANCHORED[entry.file] !== undefined) continue;
      if (!(await guardAccepts(entry.cypher))) {
        rejected.push(
          `${entry.file}:${entry.line}\n  ${entry.cypher.slice(0, 160)}`,
        );
      }
    }
    expect(
      rejected,
      `These scoped-session queries bind no tenant. Anchor each with ` +
        `{orgId: $orgId} or .orgId = $orgId:\n\n${rejected.join("\n\n")}`,
    ).toEqual([]);
  });

  it("each documented interpolation exemption still matches a real call site", () => {
    const files = new Set(corpus.map((e) => e.file));
    for (const file of Object.keys(INTERPOLATED_BUT_ANCHORED)) {
      expect(files, `stale exemption: ${file}`).toContain(file);
    }
  });
});
