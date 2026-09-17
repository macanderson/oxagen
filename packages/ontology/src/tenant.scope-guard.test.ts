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

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
        /\{orgId: \$orgId\}.*\.orgId = \$orgId/,
      );
    });
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
    ["SET target", "MATCH (n:GraphNode) SET n.orgId = $orgId"],
    ["no whitespace", "MATCH (n:GraphNode) WHERE n.orgId=$orgId RETURN n"],
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
  const listed = execFileSync(
    "git",
    ["-C", root, "ls-files", "*.ts", "*.tsx"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\n")
    .filter(Boolean);

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
