// No fabricated zeros (ARCHITECTURE.md §3.4): a mapper never invents a zero
// for a value its contract did not record. Under src/data/live/mappers/** a
// `?? 0`, `|| 0`, `?? "0"` or `|| "0"` fails, and so does a property whose
// value is, or branches to, a literal 0 or "0". Every property of a mapper is
// read, not only Count- and Money-typed ones: a mapper copies what the
// contract carries, so a constant zero in one is fabricated whatever its type.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  lineOf,
  parse,
  productionFiles,
  readSource,
  type SourceText,
} from "./parse";

const RULE = "no-fabricated-zeros";
const MAPPERS_DIR = "src/data/live/mappers/";
const PROBES = "src/test/arch/probes/no-fabricated-zeros";

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
    ? unwrap(expression.expression)
    : expression;
}

function isZero(expression: ts.Expression): boolean {
  const e = unwrap(expression);
  if (ts.isNumericLiteral(e)) return Number(e.text) === 0;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text === "0";
  }
  return (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    isZero(e.operand)
  );
}

/** Whether a value is a literal zero or branches to one. */
function reachesZero(expression: ts.Expression): boolean {
  const e = unwrap(expression);
  return ts.isConditionalExpression(e)
    ? reachesZero(e.whenTrue) || reachesZero(e.whenFalse)
    : isZero(e);
}

function zeroViolations(source: SourceText): string[] {
  const sf = parse(source);
  const violations: string[] = [];
  const fail = (node: ts.Node, what: string) => {
    violations.push(
      `${RULE} ${source.file}:${String(lineOf(sf, node))} ${what}`,
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      isZero(node.right)
    ) {
      fail(node, "fallback-zero");
    } else if (ts.isPropertyAssignment(node) && reachesZero(node.initializer)) {
      fail(node, `literal-zero:${node.name.getText(sf)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

const probe = (name: string): string[] =>
  zeroViolations(readSource(`${PROBES}/${name}`));

describe("no fabricated zeros", () => {
  it("no mapper under src/data/live/mappers fabricates a zero", () => {
    const files = productionFiles().filter((file) =>
      file.startsWith(MAPPERS_DIR),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => zeroViolations(readSource(file)))).toEqual(
      [],
    );
  });

  it("a copied count, a null fallback, a comparison and a slice pass", () => {
    expect(probe("ok.ts")).toEqual([]);
  });

  it("a mapper with ?? 0 on a count fails", () => {
    expect(probe("count-fallback.ts")).toEqual([
      `${RULE} ${PROBES}/count-fallback.ts:2 fallback-zero`,
    ]);
  });

  it('a mapper with || "0" on micros fails', () => {
    expect(probe("micros-fallback.ts")).toEqual([
      `${RULE} ${PROBES}/micros-fallback.ts:2 fallback-zero`,
    ]);
  });

  it("a literal zero, or a branch to one, assigned to a property fails", () => {
    expect(probe("literal-count.ts")).toEqual([
      `${RULE} ${PROBES}/literal-count.ts:4 literal-zero:pendingApprovals`,
      `${RULE} ${PROBES}/literal-count.ts:5 literal-zero:remainingGau`,
    ]);
  });
});
