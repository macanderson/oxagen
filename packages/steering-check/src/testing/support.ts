// support.ts: what the package's tests share. It holds a stand-in Cedar
// evaluator, the fixture's published index and outside context, and a
// builder for a check input. Lane S12 owns the real evaluator. The stand-in
// reads just enough Cedar to give each compile fixture its finding.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleSchema, type Bundle } from "@oxagen/oxagen/steering-repo";
import { FIXTURE_ROOT, fixtureContext, fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import type { CedarHooks, CedarIssue, CheckContext, CheckInput, SteeringTree } from "../types";

/** A policy's lines with string literals emptied and `//` comments cut. */
function codeLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, ""));
}

const OPENER: Readonly<Record<string, string>> = { "}": "{", ")": "(" };

/** Parse one policy file: every bracket closes, and the last policy ends with a semicolon. */
function parse(_path: string, text: string): { line: number | null; message: string }[] {
  const lines = codeLines(text);
  const open: { char: string; line: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const char of lines[index] as string) {
      if (char === "{" || char === "(") open.push({ char, line: index + 1 });
      if (char !== "}" && char !== ")") continue;
      const top = open.pop();
      if (top === undefined || top.char !== OPENER[char]) {
        return [{ line: index + 1, message: `the ${char} on line ${index + 1} closes nothing` }];
      }
    }
  }
  const unclosed = open[0];
  if (unclosed !== undefined) {
    return [{ line: unclosed.line, message: `the ${unclosed.char} on line ${unclosed.line} is not closed` }];
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim();
    if (line === "") continue;
    return line.endsWith(";") ? [] : [{ line: index + 1, message: "the policy does not end with a semicolon" }];
  }
  return [];
}

/** Each `Action::"name"` a policy names must be in the schema. */
function validate(policies: ReadonlyMap<string, string>, schema: string): CedarIssue[] {
  const issues: CedarIssue[] = [];
  for (const [path, text] of policies) {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of (lines[index] as string).matchAll(/Action::"([^"]+)"/g)) {
        const name = match[1] as string;
        if (!schema.includes(`"${name}"`)) {
          issues.push({ path, line: index + 1, message: `the action ${name} is not in the schema` });
        }
      }
    }
  }
  return issues;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The refund amount a test's context passes, or 0. */
function amountOf(test: Record<string, unknown>): number {
  const context = test.context;
  const args = isObject(context) ? context.args : undefined;
  const amount = isObject(args) ? args.amount : undefined;
  return typeof amount === "number" ? amount : 0;
}

/** Run each test line. The fixture's one policy parks a refund over 10,000 for approval. */
function test(
  _policies: ReadonlyMap<string, string>,
  _schema: string,
  tests: ReadonlyMap<string, string>,
): CedarIssue[] {
  const issues: CedarIssue[] = [];
  for (const [path, text] of tests) {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = (lines[index] as string).trim();
      if (line === "") continue;
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) continue;
      const name = typeof value.name === "string" ? value.name : `the test on line ${index + 1}`;
      const expect = typeof value.expect === "string" ? value.expect : "no decision";
      const decision = amountOf(value) > 10_000 ? "require_approval" : "allow";
      if (expect !== decision) {
        issues.push({ path, line: index + 1, message: `${name} expects ${expect}, and the policies decide ${decision}` });
      }
    }
  }
  return issues;
}

/** A stand-in for the Cedar evaluator lane S12 builds. */
export const cedarStub: CedarHooks = { parse, validate, test };

/** The fixture's outside context, without its note. */
export function context(): CheckContext {
  const { runtimes, members, teams, groups, credentials } = fixtureContext();
  return { runtimes, members, teams, groups, credentials };
}

/** The fixture bundle Oxagen published from repo/. */
export function fixtureBundle(): Bundle {
  return bundleSchema.parse(JSON.parse(readFileSync(join(FIXTURE_ROOT, "stored", "bundle.json"), "utf8")));
}

/** The published index, from the fixture bundle's records. */
export function fixtureIndex(): CheckInput["index"] {
  return { records: fixtureBundle().records };
}

/**
 * A check input for a steering PR whose head is `files`. The base is the
 * fixture repo, the index is the fixture bundle, and the Cedar stand-in
 * evaluates the policies. Pass `overrides` to change any of them.
 */
export function inputFor(files: SteeringTree, overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    files,
    base: fixtureRepo(),
    index: fixtureIndex(),
    context: context(),
    health: { differences: [] },
    cedar: cedarStub,
    ...overrides,
  };
}
