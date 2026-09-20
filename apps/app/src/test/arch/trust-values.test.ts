// INV-10 (ARCHITECTURE.md §4): a trust value — a cost basis or a tier — comes
// from a contract field or is null, never a literal. AST over
// src/data/live/mappers/**: a property or an assignment named in TRUST_NAMES
// whose value is a literal, branches to one or falls back to one fails.
// `grade` and `verdict` joined the list with the lanes that first rendered
// them: the ladder rung on the Run page, and the Verdict column on Fleet.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  lineOf,
  parse,
  productionFiles,
  readSource,
  WHOLE_TREE_TIMEOUT_MS,
  type SourceText,
} from "./parse";

const RULE = "trust-values";
const MAPPERS_DIR = "src/data/live/mappers/";
const PROBES = "src/test/arch/probes/trust-values";
const TRUST_NAMES: ReadonlySet<string> = new Set([
  "basis",
  "tier",
  "verdict",
  "grade",
]);

function isLiteral(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTemplateExpression(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isBigIntLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  );
}

/** Whether a value is a literal, branches to one or falls back to one. */
function reachesLiteral(expression: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return reachesLiteral(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      reachesLiteral(expression.whenTrue) ||
      reachesLiteral(expression.whenFalse)
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return reachesLiteral(expression.left) || reachesLiteral(expression.right);
  }
  return isLiteral(expression);
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function trustValueViolations(source: SourceText): string[] {
  const sf = parse(source);
  const violations: string[] = [];
  const check = (node: ts.Node, name: string | null, value: ts.Expression) => {
    if (name !== null && TRUST_NAMES.has(name) && reachesLiteral(value)) {
      violations.push(
        `${RULE} ${source.file}:${String(lineOf(sf, node))} ${name}`,
      );
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      check(node, propertyName(node.name), node.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      check(node, node.left.name.text, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

const probe = (name: string): string[] =>
  trustValueViolations(readSource(`${PROBES}/${name}`));

describe("trust values", () => {
  it(
    "no mapper under src/data/live/mappers states a basis or tier as a literal",
    () => {
      const files = productionFiles().filter((file) =>
        file.startsWith(MAPPERS_DIR),
      );
      expect(files.length).toBeGreaterThan(0);
      expect(
        files.flatMap((file) => trustValueViolations(readSource(file))),
      ).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("a contract field, a null fallback and a literal under another name pass", () => {
    expect(probe("ok.ts")).toEqual([]);
  });

  it("a literal basis fails", () => {
    expect(probe("literal-basis.ts")).toEqual([
      `${RULE} ${PROBES}/literal-basis.ts:2 basis`,
    ]);
  });

  it("a tier that falls back to a literal fails", () => {
    expect(probe("fallback-tier.ts")).toEqual([
      `${RULE} ${PROBES}/fallback-tier.ts:2 tier`,
    ]);
  });

  it("a basis assigned a branch that reaches a literal fails", () => {
    expect(probe("assigned-basis.ts")).toEqual([
      `${RULE} ${PROBES}/assigned-basis.ts:3 basis`,
    ]);
  });
});
