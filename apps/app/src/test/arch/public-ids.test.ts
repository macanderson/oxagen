// INV-11 (ARCHITECTURE.md §4): every view-model field named `id` or ending in
// `Id` is a `PublicId`, with an empty allowlist. Every zod object shape in
// src/data/contracts is walked — `z.object`, `z.strictObject`, `z.looseObject`
// and `.extend` arguments, nested in arrays and unions alike — so no exported
// view model carries a raw database id under any name.
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

const RULE = "public-ids";
const CONTRACTS_DIR = "src/data/contracts/";
const PROBES = "src/test/arch/probes/public-ids";

const SHAPE_CALLS: ReadonlySet<string> = new Set([
  "object",
  "strictObject",
  "looseObject",
  "extend",
  "safeExtend",
]);

function isIdField(name: string): boolean {
  return name === "id" || name.endsWith("Id");
}

/** `PublicId`, bare or with modifiers such as `.nullable()` and `.optional()`. */
function isPublicId(expression: ts.Expression): boolean {
  let head = expression;
  while (
    ts.isCallExpression(head) &&
    ts.isPropertyAccessExpression(head.expression)
  ) {
    head = head.expression.expression;
  }
  return ts.isIdentifier(head) && head.text === "PublicId";
}

/** The object literal a zod shape call takes, or null for any other call. */
function shapeOf(call: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const [first] = call.arguments;
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !SHAPE_CALLS.has(call.expression.name.text) ||
    first === undefined
  ) {
    return null;
  }
  return ts.isObjectLiteralExpression(first) ? first : null;
}

function fieldName(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name;
  if (name === undefined) return null;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function publicIdViolations(source: SourceText): string[] {
  const sf = parse(source);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    const shape = ts.isCallExpression(node) ? shapeOf(node) : null;
    for (const property of shape?.properties ?? []) {
      const name = fieldName(property);
      if (name === null || !isIdField(name)) continue;
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : null;
      if (value === null || !isPublicId(value)) {
        violations.push(
          `${RULE} ${source.file}:${String(lineOf(sf, property))} ${name}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

const probe = (name: string): string[] =>
  publicIdViolations(readSource(`${PROBES}/${name}`));

describe("public ids", () => {
  it(
    "every id field of a view model in src/data/contracts is a PublicId",
    () => {
      const files = productionFiles().filter((file) =>
        file.startsWith(CONTRACTS_DIR),
      );
      expect(files.length).toBeGreaterThan(0);
      expect(
        files.flatMap((file) => publicIdViolations(readSource(file))),
      ).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("a PublicId, a modified PublicId and a name that only ends in id pass", () => {
    expect(probe("ok.ts")).toEqual([]);
  });

  it("a non-PublicId id field fails at the top level", () => {
    expect(probe("bare-id.ts")).toEqual([
      `${RULE} ${PROBES}/bare-id.ts:4 runId`,
    ]);
  });

  it("a non-PublicId id field fails nested in an array", () => {
    expect(probe("nested-id.ts")).toEqual([
      `${RULE} ${PROBES}/nested-id.ts:5 id`,
    ]);
  });

  it("a non-PublicId id field fails in an extension, shorthand included", () => {
    expect(probe("extend-id.ts")).toEqual([
      `${RULE} ${PROBES}/extend-id.ts:8 requestedById`,
      `${RULE} ${PROBES}/extend-id.ts:9 agentId`,
    ]);
  });
});
