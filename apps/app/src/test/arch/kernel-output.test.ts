// INV-04 (ARCHITECTURE.md §3.2, §4): every kernel result reaches a caller
// parsed by its contract's output schema, or as `contract_output_mismatch`
// with status 502, and the kernel's `invalid_input` and `invalid_output` codes
// are classified by name. INV-03 makes src/server/kernel.ts the one module that
// calls invoke(); this test holds the one path through it:
//
//   - each invoke() result is awaited straight into a `raw` property, so no
//     name holds an answer a caller could be handed unparsed;
//   - each read of `.raw` is the argument of `<contract>.output.safeParse`;
//   - the function that parses it answers a failed parse with
//     `code: "contract_output_mismatch"` and `status: 502`;
//   - classifyKernelFailure has a `case` for `invalid_input`, and one for
//     `invalid_output` that answers the same mismatch, so neither code falls
//     to the default.
//
// What each path returns at runtime (success, mismatch, one telemetry report,
// both invalid_* codes) is proved by src/server/kernel.test.ts.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { lineOf, listFiles, parse, readSource, type SourceText } from "./parse";

const KERNEL = "src/server/kernel.ts";
const CLASSIFIER = "classifyKernelFailure";
const MISMATCH = { code: "contract_output_mismatch", status: "502" };

/** `raw: await invoke(…)`: the answer goes into the one property parsed. */
function isAwaitedIntoRaw(call: ts.CallExpression): boolean {
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited)) return false;
  const property = awaited.parent;
  return (
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    property.name.text === "raw"
  );
}

/** `<x>.output.safeParse(<access>)`. */
function isOutputParseArgument(access: ts.PropertyAccessExpression): boolean {
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== access) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "safeParse" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "output"
  );
}

function propertyValue(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of literal.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/** Whether `node` holds `{ code: "contract_output_mismatch", status: 502 }`. */
function answersMismatch(node: ts.Node): boolean {
  if (ts.isObjectLiteralExpression(node)) {
    const code = propertyValue(node, "code");
    const status = propertyValue(node, "status");
    if (
      code !== undefined &&
      ts.isStringLiteral(code) &&
      code.text === MISMATCH.code &&
      status !== undefined &&
      ts.isNumericLiteral(status) &&
      status.text === MISMATCH.status
    ) {
      return true;
    }
  }
  return (
    ts.forEachChild(node, (child) => answersMismatch(child) || undefined) ??
    false
  );
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The function `node` sits in, or the source file when it sits in none. */
function enclosingFunction(node: ts.Node): ts.Node {
  let at: ts.Node = node.parent;
  while (!ts.isSourceFile(at) && !isFunctionLike(at)) at = at.parent;
  return at;
}

/**
 * The clause that runs for `case "<code>":`, following a fall-through to the
 * next clause with statements.
 */
function clauseFor(fn: ts.Node, code: string): ts.CaseClause | null {
  const found: ts.CaseClause[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCaseBlock(node)) {
      const clauses = node.clauses;
      const at = clauses.findIndex(
        (clause) =>
          ts.isCaseClause(clause) &&
          ts.isStringLiteral(clause.expression) &&
          clause.expression.text === code,
      );
      const runs = clauses
        .slice(Math.max(at, 0))
        .find((clause) => clause.statements.length > 0);
      if (at !== -1 && runs !== undefined && ts.isCaseClause(runs)) {
        found.push(runs);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found[0] ?? null;
}

function kernelOutputViolations(source: SourceText): string[] {
  const sf = parse(source);
  const out: string[] = [];
  const parses: ts.PropertyAccessExpression[] = [];
  const classifiers: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    const line = (): string => String(lineOf(sf, node));
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "invoke" &&
      !isAwaitedIntoRaw(node)
    ) {
      out.push(`invoke() result outside a raw property (line ${line()})`);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "raw"
    ) {
      if (isOutputParseArgument(node)) parses.push(node);
      else out.push(`raw read outside output.safeParse (line ${line()})`);
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === CLASSIFIER
    ) {
      classifiers.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (parses.length === 0) out.push("no output.safeParse of a raw result");
  for (const access of parses) {
    if (!answersMismatch(enclosingFunction(access))) {
      const line = String(lineOf(sf, access));
      out.push(
        `output parse without contract_output_mismatch 502 (line ${line})`,
      );
    }
  }

  const [classifier] = classifiers;
  if (classifier === undefined) {
    out.push(`no ${CLASSIFIER}`);
    return out;
  }
  if (clauseFor(classifier, "invalid_input") === null) {
    out.push("no case for invalid_input");
  }
  const invalidOutput = clauseFor(classifier, "invalid_output");
  if (invalidOutput === null) {
    out.push("no case for invalid_output");
  } else if (!answersMismatch(invalidOutput)) {
    out.push("invalid_output not classified as contract_output_mismatch 502");
  }
  return out;
}

describe("kernel output (INV-04)", () => {
  it("parses every kernel result by its contract, or answers contract_output_mismatch 502", () => {
    expect(kernelOutputViolations(readSource(KERNEL))).toEqual([]);
  });
});

// --- Probes -----------------------------------------------------------------
//
// Each file under probes/kernel-output is judged as if it were the kernel and
// must produce the named violation.

const PROBE_DIR = "src/test/arch/probes/kernel-output";
const PROBES: Readonly<Record<string, string>> = {
  "raw-returned.ts": "raw read outside output.safeParse",
  "invoke-bound.ts": "invoke() result outside a raw property",
  "mismatch-missing.ts": "output parse without contract_output_mismatch 502",
  "invalid-input-default.ts": "no case for invalid_input",
  "invalid-output-default.ts": "no case for invalid_output",
  "invalid-output-unavailable.ts":
    "invalid_output not classified as contract_output_mismatch 502",
};

describe("kernel output probes", () => {
  it("every probe file is placed", () => {
    expect(
      listFiles(PROBE_DIR).map((f) => f.slice(PROBE_DIR.length + 1)),
    ).toEqual(Object.keys(PROBES).sort());
  });

  for (const [probe, violation] of Object.entries(PROBES)) {
    it(`${probe} fails with ${violation}`, () => {
      const { text } = readSource(`${PROBE_DIR}/${probe}`);
      const found = kernelOutputViolations({ file: KERNEL, text });
      expect(
        found.some((v) => v.startsWith(violation)),
        found.join("\n"),
      ).toBe(true);
    });
  }
});
