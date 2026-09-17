// INV-18 (ARCHITECTURE.md §3.6, §4): an unbacked page is exactly one UNRECORDED
// row rendered only by <NotRecorded>, and the table only shrinks.
//
//   - the table's keys are a subset of the five §3.6 keys;
//   - every <NotRecorded section=…> in a production module names a row of the
//     table with a string literal, so a section can never be computed;
//   - every whole-page row (`gap: null`) is rendered by a route's page.tsx: a
//     key whose page has landed no longer has a renderer and must be deleted
//     in the same PR (the in-page row `run.frames_wrapped` is rendered by the
//     Run frames section once WL-35 lands it; until then nothing renders it,
//     and this test asks nothing of it beyond the literal rule);
//   - no DataSource port and no contract symbol shares a row key: a port or a
//     view model named for a page is that page's backing, so the row must go.
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { UNRECORDED } from "@/data/unrecorded";
import {
  listFiles,
  parse,
  productionFiles,
  readSource,
  type SourceText,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

const RULE = "unrecorded";

/** The five §3.6 keys; a table may hold fewer, never another. */
const REV1_KEYS: readonly string[] = [
  "agents",
  "tools",
  "steering",
  "spend",
  "run.frames_wrapped",
];

const TABLE_FILE = "src/data/unrecorded.ts";
const PORTS_FILE = "src/data/ports.ts";
const CONTRACTS_DIR = "src/data/contracts";
const PROBES = "src/test/arch/probes/unrecorded/";

type Row = { readonly key: string; readonly inPage: boolean };

/** What the test reads: the table, the modules that may render a row, the routes, the ports and the contracts. */
type Tree = {
  readonly table: SourceText;
  readonly modules: readonly SourceText[];
  readonly routes: readonly SourceText[];
  readonly ports: SourceText;
  readonly contracts: readonly SourceText[];
};

// --- Reading the table ------------------------------------------------------

function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** The rows of `export const UNRECORDED = { … }`; a row is in-page when its `gap` is not the null literal. */
function tableRows(source: SourceText): Row[] {
  const sf = parse(source);
  const rows: Row[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "UNRECORDED" ||
        declaration.initializer === undefined
      ) {
        continue;
      }
      let literal: ts.Expression = declaration.initializer;
      // `{…} as const satisfies …` wraps the literal twice.
      while (ts.isAsExpression(literal) || ts.isSatisfiesExpression(literal)) {
        literal = literal.expression;
      }
      if (!ts.isObjectLiteralExpression(literal)) continue;
      for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyKey(property.name);
        if (key === null) continue;
        rows.push({ key, inPage: !isNullGap(property.initializer) });
      }
    }
  }
  return rows;
}

function isNullGap(value: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      propertyKey(p.name) === "gap" &&
      p.initializer.kind === ts.SyntaxKind.NullKeyword,
  );
}

// --- Reading the renders ----------------------------------------------------

type Render = {
  readonly line: number;
  /** The literal section, or null when the attribute is computed or missing. */
  readonly section: string | null;
};

/** Every `<NotRecorded …>` in a module, with its `section` when it is a string literal. */
function renders(source: SourceText): Render[] {
  const sf = parse(source);
  const out: Render[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "NotRecorded"
    ) {
      const attribute = node.attributes.properties.find(
        (p): p is ts.JsxAttribute =>
          ts.isJsxAttribute(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "section",
      );
      out.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        section: literalSection(attribute?.initializer),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function literalSection(
  initializer: ts.JsxAttributeValue | undefined,
): string | null {
  if (initializer === undefined) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    (ts.isStringLiteral(initializer.expression) ||
      ts.isNoSubstitutionTemplateLiteral(initializer.expression))
  ) {
    return initializer.expression.text;
  }
  return null;
}

// --- Reading the ports and contracts -----------------------------------------

/** The member names of `DataSource`, whether an interface or a type literal alias. */
function portNames(source: SourceText): string[] {
  const sf = parse(source);
  const names: string[] = [];
  const collect = (members: ts.NodeArray<ts.TypeElement>): void => {
    for (const member of members) {
      if (member.name !== undefined) {
        const key = propertyKey(member.name);
        if (key !== null) names.push(key);
      }
    }
  };
  for (const statement of sf.statements) {
    if (
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "DataSource"
    ) {
      collect(statement.members);
    }
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "DataSource" &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      collect(statement.type.members);
    }
  }
  return names;
}

/** A contract module's file stem and its exported top-level names, lowercased for the comparison. */
function contractSymbols(source: SourceText): string[] {
  const sf = parse(source);
  const stem = path.posix.basename(source.file).replace(/\.tsx?$/, "");
  const names = [stem];
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts
      .getModifiers(node)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
      false);
  for (const statement of sf.statements) {
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
    } else if (
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return names.map((name) => name.toLowerCase());
}

// --- The rule -----------------------------------------------------------------

/** `unrecorded <file>[:<line>] <detail>` for every violation in the tree. */
function violations(tree: Tree): string[] {
  const out: string[] = [];
  const rows = tableRows(tree.table);
  const keys = new Set(rows.map((row) => row.key));
  for (const row of rows) {
    if (!REV1_KEYS.includes(row.key)) {
      out.push(`${RULE} ${tree.table.file} key-outside-rev1 ${row.key}`);
    }
  }
  const rendered = new Set<string>();
  for (const module of tree.modules) {
    for (const render of renders(module)) {
      const at = `${module.file}:${String(render.line)}`;
      if (render.section === null) {
        out.push(`${RULE} ${at} section-not-literal`);
      } else if (!keys.has(render.section)) {
        out.push(`${RULE} ${at} section-not-in-table ${render.section}`);
      }
    }
  }
  for (const route of tree.routes) {
    for (const render of renders(route)) {
      if (render.section !== null) rendered.add(render.section);
    }
  }
  for (const row of rows) {
    if (!row.inPage && !rendered.has(row.key)) {
      out.push(`${RULE} ${tree.table.file} page-landed ${row.key}`);
    }
  }
  for (const name of portNames(tree.ports)) {
    if (keys.has(name)) {
      out.push(`${RULE} ${tree.ports.file} port-shares-key ${name}`);
    }
  }
  for (const contract of tree.contracts) {
    for (const symbol of contractSymbols(contract)) {
      const key = [...keys].find((k) => k.toLowerCase() === symbol);
      if (key !== undefined) {
        out.push(`${RULE} ${contract.file} contract-shares-key ${key}`);
      }
    }
  }
  return out.sort();
}

function productionTree(): Tree {
  const files = productionFiles();
  const isRoute = (file: string): boolean =>
    file.startsWith("src/app/") && file.endsWith("/page.tsx");
  return {
    table: readSource(TABLE_FILE),
    modules: files.filter((f) => f.startsWith("src/")).map(readSource),
    routes: files.filter(isRoute).map(readSource),
    ports: readSource(PORTS_FILE),
    contracts: listFiles(CONTRACTS_DIR)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map(readSource),
  };
}

const probe = (name: string): SourceText => readSource(`${PROBES}${name}`);

/** The clean probe tree: a five-row table, one route per whole-page row, no ports, no contract that shares a key. */
function probeTree(over: Partial<Tree> = {}): Tree {
  const routes = [
    probe("page-agents.tsx"),
    probe("page-tools.tsx"),
    probe("page-steering.tsx"),
    probe("page-spend.tsx"),
  ];
  return {
    table: probe("table-ok.ts"),
    modules: routes,
    routes,
    ports: probe("ports-empty.ts"),
    contracts: [probe("contracts/money.ts")],
    ...over,
  };
}

describe("unrecorded", () => {
  it("reads the real table as the module exports it", () => {
    expect(tableRows(readSource(TABLE_FILE)).map((row) => row.key)).toEqual(
      Object.keys(UNRECORDED),
    );
  });

  it(
    "the production tree has no violation",
    () => {
      expect(violations(productionTree())).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("the clean probe tree has no violation", () => {
    expect(violations(probeTree())).toEqual([]);
  });

  it("refuses a key outside the five §3.6 keys, and reports it unrendered besides", () => {
    expect(
      violations(
        probeTree({
          table: probe("table-outside.ts"),
          modules: [],
          routes: [],
        }),
      ),
    ).toEqual([
      `${RULE} ${PROBES}table-outside.ts key-outside-rev1 ontology`,
      `${RULE} ${PROBES}table-outside.ts page-landed ontology`,
    ]);
  });

  it("refuses a computed section and a section that is not a row", () => {
    const modules = [probe("page-non-literal.tsx"), probe("page-unknown.tsx")];
    expect(violations(probeTree({ modules }))).toEqual([
      `${RULE} ${PROBES}page-non-literal.tsx:4 section-not-literal`,
      `${RULE} ${PROBES}page-unknown.tsx:3 section-not-in-table ontology`,
    ]);
  });

  it("fails a whole-page row no route renders: the page landed and the row must go", () => {
    const routes = [
      probe("page-agents.tsx"),
      probe("page-steering.tsx"),
      probe("page-spend.tsx"),
    ];
    expect(violations(probeTree({ modules: routes, routes }))).toEqual([
      `${RULE} ${PROBES}table-ok.ts page-landed tools`,
    ]);
  });

  it("asks no renderer of the in-page row, and holds it to the literal rule", () => {
    // The clean tree renders run.frames_wrapped nowhere and passes; rendering
    // it with a literal is fine, rendering it computed is not.
    const literal = probe("page-run-frames.tsx");
    expect(
      violations(probeTree({ modules: [...probeTree().modules, literal] })),
    ).toEqual([]);
  });

  it("refuses a DataSource port and a contract module that share a row key", () => {
    expect(
      violations(
        probeTree({
          ports: probe("ports-shares-key.ts"),
          contracts: [probe("contracts/agents.ts")],
        }),
      ),
    ).toEqual([
      `${RULE} ${PROBES}contracts/agents.ts contract-shares-key agents`,
      `${RULE} ${PROBES}contracts/agents.ts contract-shares-key tools`,
      `${RULE} ${PROBES}ports-shares-key.ts port-shares-key spend`,
    ]);
  });
});
