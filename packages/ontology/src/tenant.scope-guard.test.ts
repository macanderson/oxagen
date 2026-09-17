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
vi.mock("./client", () => ({ session: () => ({ run, close }) }));

import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "./tenant";
import {
  keepFilteringPositions,
  stripLiteralsAndComments,
} from "./graph-scope";

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
// Each one contains a genuine anchor: seam-bound `$orgId`, in a filtering
// position, in a row-selecting clause. The anchor is simply not the only thing
// the query reads. No refinement of a SYNTACTIC check closes this, and that
// includes a full Cypher parse — a parser reports structure, and the structure
// here is correct. What is wrong is reachability, which is a semantic property
// of the whole query.
//
// The real guarantee belongs elsewhere: see the ADR referenced from
// packages/ontology/src/tenant.ts.
describe("tenancy guard — KNOWN cross-tenant reads it accepts", () => {
  const accepted: Array<[name: string, cypher: string]> = [
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
      "a traversal leaving the anchored node",
      "MATCH (a {orgId: $orgId})-[*1..3]-(b) RETURN b",
    ],
    [
      "a MERGE that anchors, followed by an unanchored MATCH",
      "MERGE (a:GraphNode {orgId: $orgId}) WITH a MATCH (b) RETURN b",
    ],
  ];

  for (const [name, cypher] of accepted) {
    it(`accepts (and should not be trusted): ${name}`, async () => {
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
      "a CALL subquery's inner clauses are still clauses",
      "MATCH (a) WHERE a.orgId = $orgId CALL { WITH a MATCH (b) WHERE b.id = a.id RETURN b } RETURN b",
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
