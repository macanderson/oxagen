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
//
// ## The second half: using the seam is not the same as using the right one
//
// There are two seams over that column, because the same column answers two
// questions depending on which principal row the join arrives at.
// `operatorUserJoin` starts from a run's initiating principal and carries
// `kind = 'human'`. `agentCreatorUserJoin` starts from `agents.principal_id`,
// which is provisioned `kind = 'agent'` with `parent_user_id` = the registering
// user, and carries no kind filter because for that row the parent user is the
// answer rather than a bystander.
//
// Reaching for the seam and reaching for the wrong one look identical in a
// diff, and that is what happened: `_agent-identity.ts` was moved off an inline
// condition onto `operatorUserJoin`, whose `kind = 'human'` can never match an
// agent's own principal, so `list_agents` and `get_agent` reported no operator
// for every agent (discussion_r4051925928).
//
// This half IS expressible, and structurally rather than by naming files: a
// select that joins `principals` on `agents.principalId` has an AGENT principal
// in hand by construction, so a `users` join in that same chain must not use
// `operatorUserJoin`. What is NOT expressible is the general question — whether
// an arbitrary `operatorUserJoin` reaches a human principal — because that
// depends on which rows the query selects, which no parse of the source can
// answer. The rule below is the case this codebase actually has, stated
// precisely, and it is not a stand-in for the general one.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Every `users` join in a chain that has already joined an AGENT's own
 * principal but reaches for the operator seam.
 *
 * Both facts are read off the same file rather than the same expression: a
 * `principals` join keyed on `agents.principalId`, and an `operatorUserJoin`
 * against `users`. A source that holds both is holding the defect, because the
 * only principal row such a file joins is the agent's, and no agent principal
 * is `kind = 'human'`.
 */
function agentPrincipalOnOperatorJoin(path: string): string[] {
  const text = readFileSync(path, "utf8");
  if (!text.includes("operatorUserJoin")) return [];
  if (!/agents\.principalId/.test(text)) return [];
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
      node.arguments.length >= 2 &&
      /(^|\.)users$/.test(node.arguments[0]?.getText(source) ?? "") &&
      (node.arguments[1]?.getText(source) ?? "").includes("operatorUserJoin")
    ) {
      found.push(
        `${node.expression.name.text}(users, operatorUserJoin) at line ${
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

  it("is not the seam a file holding an agent's own principal reaches for", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const path of sourcesUnder(root)) {
        for (const site of agentPrincipalOnOperatorJoin(path))
          offenders.push(`${relative(root, path)}: ${site}`);
      }
    }
    // A failure here means the file joins an agent's delegated principal
    // (`kind = 'agent'`) and then asks for the operator seam, which requires
    // `kind = 'human'` and therefore matches nothing. Use
    // `agentCreatorUserJoin`.
    expect(offenders).toEqual([]);
  });

  it("detects each of the two shapes it bans", () => {
    // The discriminating case for both scans, on strings rather than on the
    // tree, so a scan that matched nothing at all could not pass by finding a
    // clean repository.
    const withSeam = `tx.select(c).from(schema.agents)
      .leftJoin(schema.principals, eq(schema.principals.id, schema.agents.principalId))
      .leftJoin(schema.users, agentCreatorUserJoin);`;
    const wrongSeam = `tx.select(c).from(schema.agents)
      .leftJoin(schema.principals, eq(schema.principals.id, schema.agents.principalId))
      .leftJoin(schema.users, operatorUserJoin);`;
    const inline = `tx.select(c).from(schema.agents)
      .leftJoin(schema.users, eq(schema.users.id, schema.principals.parentUserId));`;
    const scan = (
      source: string,
      fn: (path: string) => string[],
    ): string[] => {
      const file = join(mkdtempSync(join(tmpdir(), "seam-")), "probe.ts");
      writeFileSync(file, source);
      return fn(file);
    };
    expect(scan(wrongSeam, agentPrincipalOnOperatorJoin)).toHaveLength(1);
    expect(scan(withSeam, agentPrincipalOnOperatorJoin)).toEqual([]);
    expect(scan(inline, inlineOperatorJoins)).toHaveLength(1);
    expect(scan(withSeam, inlineOperatorJoins)).toEqual([]);
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
