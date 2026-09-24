// INV-05 (ARCHITECTURE.md §3.7, §4): src/server/tenancy-lookups.ts is the one
// module under src/ that issues a database statement (the import graph's
// platform allowlist keeps @oxagen/database out of every other module), and it
// reads only the tables resolving a viewer and an invitation needs before a
// tenant scope exists. The walk sees every `schema.<table>` member access; so
// that no other form escapes it, the module may import only `schema` and
// `withSystemDb` from @oxagen/database, never `sql` from drizzle-orm and
// nothing dynamically, may not use `schema` except as `schema.<table>`, and
// may not touch the relational query API, raw execution or a write.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listFiles, parse, readSource, type SourceText } from "./parse";

const LOOKUPS = "src/server/tenancy-lookups.ts";

/** `schema.<table>` → the columns it may be read by, or null for any column. */
const TABLES: Readonly<Record<string, readonly string[] | null>> = {
  organizations: null,
  orgSlugHistory: null,
  workspaces: null,
  workspaceSlugHistory: null,
  orgUsers: null,
  workspaceUsers: null,
  orgSecurityPolicy: null,
  users: ["id", "twoFactorEnabled", "displayName"],
  invitations: null,
  // The require-SSO gate needs an organization's verified provider ids and
  // nothing else; oidcConfig and samlConfig hold sealed secrets (ADR-145).
  ssoProviderTable: ["providerId", "organizationId", "domainVerified"],
};

const DATABASE_EXPORTS: readonly string[] = ["schema", "withSystemDb"];

/** Members that read around the walk (the relational query API, raw SQL) or write. */
const REFUSED_MEMBERS: readonly string[] = [
  "query",
  "execute",
  "insert",
  "update",
  "delete",
];

function importViolations(
  sf: ts.SourceFile,
  schemaNames: Set<string>,
): string[] {
  const out: string[] = [];
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (specifier !== "@oxagen/database" && specifier !== "drizzle-orm") {
      continue;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (clause?.name || (bindings && ts.isNamespaceImport(bindings))) {
      out.push(`whole-module import ${specifier}`);
      continue;
    }
    const elements =
      bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
    for (const element of elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (specifier === "drizzle-orm" && imported === "sql") {
        out.push("sql import");
      } else if (specifier === "@oxagen/database") {
        if (!DATABASE_EXPORTS.includes(imported)) {
          out.push(`@oxagen/database import ${imported}`);
        } else if (imported === "schema") {
          schemaNames.add(element.name.text);
        }
      }
    }
  }
  return out;
}

/** `X.select({…}).from(schema.users)`: the bare table names the source of a select whose columns are walked themselves. */
function isSourceOfColumnSelect(access: ts.Node): boolean {
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== access) return false;
  const from = call.expression;
  if (!ts.isPropertyAccessExpression(from) || from.name.text !== "from") {
    return false;
  }
  const select = from.expression;
  return (
    ts.isCallExpression(select) &&
    ts.isPropertyAccessExpression(select.expression) &&
    select.expression.name.text === "select" &&
    select.arguments.length === 1 &&
    select.arguments[0] !== undefined &&
    ts.isObjectLiteralExpression(select.arguments[0])
  );
}

/** One reference to the imported `schema` binding. */
function schemaViolations(node: ts.Identifier): string[] {
  const parent = node.parent;
  // A type position (`typeof schema.organizations.$inferSelect`) issues no statement.
  if (ts.isQualifiedName(parent) && parent.left === node) {
    return parent.right.text in TABLES ? [] : [`table ${parent.right.text}`];
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
    return [`schema used as a value: ${parent.getText()}`];
  }
  const table = parent.name.text;
  const columns = TABLES[table];
  if (columns === undefined) return [`table ${table}`];
  if (columns === null) return [];
  const column = parent.parent;
  if (ts.isPropertyAccessExpression(column) && column.expression === parent) {
    return columns.includes(column.name.text)
      ? []
      : [`column ${table}.${column.name.text}`];
  }
  return isSourceOfColumnSelect(parent) ? [] : [`every column of ${table}`];
}

function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  return true;
}

function tableViolations(source: SourceText): string[] {
  const sf = parse(source);
  const schemaNames = new Set<string>();
  const out = importViolations(sf, schemaNames);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      out.push("dynamic import");
    } else if (
      ts.isPropertyAccessExpression(node) &&
      REFUSED_MEMBERS.includes(node.name.text)
    ) {
      out.push(`member ${node.name.text}`);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      REFUSED_MEMBERS.includes(node.argumentExpression.text)
    ) {
      out.push(`member ${node.argumentExpression.text}`);
    } else if (
      ts.isIdentifier(node) &&
      schemaNames.has(node.text) &&
      isReference(node)
    ) {
      out.push(...schemaViolations(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("tenancy-lookups tables (INV-05)", () => {
  it("reads only the allowlisted tables, users by id and twoFactorEnabled alone", () => {
    const source = readSource(LOOKUPS);
    expect(source.text).toContain("withSystemDb");
    expect(tableViolations(source)).toEqual([]);
  });
});

// --- Probes -----------------------------------------------------------------
//
// Each file under probes/tenancy-lookups-tables is judged as if it were the
// lookups module and must produce the named violation.

const PROBE_DIR = "src/test/arch/probes/tenancy-lookups-tables";
const PROBES: Readonly<Record<string, string>> = {
  "source-connections.ts": "table sourceConnections",
  "query-invitations.ts": "member query",
  "sql-import.ts": "sql import",
  "users-column.ts": "column users.email",
  "users-every-column.ts": "every column of users",
  "schema-escape.ts": "schema used as a value",
  "write.ts": "member insert",
  "other-database-export.ts": "@oxagen/database import db",
  "dynamic-import.ts": "dynamic import",
};

describe("tenancy-lookups tables probes", () => {
  it("every probe file is placed", () => {
    expect(
      listFiles(PROBE_DIR).map((f) => f.slice(PROBE_DIR.length + 1)),
    ).toEqual(Object.keys(PROBES).sort());
  });

  for (const [probe, violation] of Object.entries(PROBES)) {
    it(`${probe} fails with ${violation}`, () => {
      const { text } = readSource(`${PROBE_DIR}/${probe}`);
      const found = tableViolations({ file: LOOKUPS, text });
      expect(
        found.some((v) => v.startsWith(violation)),
        found.join("\n"),
      ).toBe(true);
    });
  }
});
