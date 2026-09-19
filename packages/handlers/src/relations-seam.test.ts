// relations-seam.test.ts — AGENTS.md: "Cross-domain Postgres queries use
// `src/relations.ts` (Drizzle). Never write raw cross-schema JOINs inside
// handlers."
//
// The rule matters most where the relationship carries a condition that is not
// the foreign key. A run records the principal that started it, and a person's
// name is reached by joining `auth.users` to `iam.principals.parent_user_id` —
// but only for `kind = 'human'`. A delegated agent principal carries its
// creator's `parent_user_id`, so a join on the column alone puts the person who
// built the agent on every run the agent started, which is a name the record
// does not claim. Written inline in a handler, that condition is duplicated
// once per query and one copy can be forgotten; the copy that is forgotten is
// the one that mis-attributes a run.
//
// So this test bans the inline form and requires the seam
// (`operatorUserJoin`, `packages/database/src/relations.ts`). It parses each
// handler source with the TypeScript compiler API rather than grepping,
// because the join reads across several lines and the condition it must not
// carry is an argument, not a line.
//
// Scope: a join whose joined table is `users` and whose condition mentions
// `parentUserId`. A join on a direct foreign key — `users.id = actorUserId`,
// `users.id = orgUsers.userId` — is one relationship stated once and is left
// alone; there is nothing about it a second copy could get wrong.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOTS = [
  join(import.meta.dirname, "."),
  join(import.meta.dirname, "..", "..", "agent", "src"),
];

const JOIN_METHODS = new Set(["leftJoin", "innerJoin", "rightJoin", "fullJoin"]);

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourcesUnder(path));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(path);
  }
  return out;
}

/** Every `<table>` joined with a condition naming `parentUserId`, by file. */
function inlineOperatorJoins(path: string): string[] {
  const text = readFileSync(path, "utf8");
  // Cheap pre-filter: the compiler API is not worth running on a file that
  // cannot possibly hold the join.
  if (!text.includes("parentUserId")) return [];
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      JOIN_METHODS.has(node.expression.name.text) &&
      node.arguments.length >= 2
    ) {
      const table = node.arguments[0]?.getText(source) ?? "";
      const condition = node.arguments[1]?.getText(source) ?? "";
      if (/(^|\.)users$/.test(table) && condition.includes("parentUserId"))
        found.push(
          `${node.expression.name.text}(${table}, …) at line ${
            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          }`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the principal-to-user join lives in the relations seam", () => {
  it("is not written inline in any handler", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const path of sourcesUnder(root)) {
        for (const site of inlineOperatorJoins(path))
          offenders.push(`${relative(root, path)}: ${site}`);
      }
    }
    // A failure here is not a style note. Import `operatorUserJoin` from
    // `@oxagen/database` and pass it as the join condition; the `kind`
    // filter it carries is what keeps an agent's creator off the agent's runs.
    expect(offenders).toEqual([]);
  });

  it("is what `list_runs` joins on, in both of its selects", () => {
    // The ledger select and the Tacho session select each reach for the
    // operator's name, so each is a place the condition could drift.
    const text = readFileSync(
      join(import.meta.dirname, "run.list.ts"),
      "utf8",
    );
    expect(text).toMatch(
      /import\s*\{[^}]*\boperatorUserJoin\b[^}]*\}\s*from\s*"@oxagen\/database"/s,
    );
    expect(text.match(/Join\(schema\.users,\s*operatorUserJoin\)/g)).toHaveLength(
      2,
    );
  });
});
