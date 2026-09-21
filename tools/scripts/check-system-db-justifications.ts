#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const BASELINE_PATH =
  "tools/scripts/system-db-justifications.baseline.json";
export type Baseline = Record<string, string[]>;
export interface SystemCall {
  file: string;
  line: number;
  fingerprint: string;
  justified: boolean;
}
const printer = ts.createPrinter({ removeComments: true });

/** Syntax is enforced here. Review must verify the stated fence against the query. */
export function substantiveJustification(comment: string): boolean {
  const rationale = comment.match(/\btenancy:\s*([\s\S]+)/)?.[1];
  return Boolean(
    rationale &&
      rationale.trim().split(/\s+/).length >= 8 &&
      /\b(orgId|userId|workspaceId|global|cross-tenant|all orgs|all organizations|webhook|migration|bootstrap)\b/i.test(
        rationale,
      ) &&
      /\b(scoped|filter|filtered|verified|validated|membership|authenticated|signed|global|scheduled|migration|bootstrap|no org_id)\b/i.test(
        rationale,
      ),
  );
}

export function scanSystemCalls(file: string, text: string): SystemCall[] {
  if (!text.includes("withSystemDb")) return [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const aliases = new Set(["withSystemDb"]);
  const access = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && aliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "withSystemDb") ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "withSystemDb");
  // Named imports and simple local aliases must not bypass the call-site rule.
  let changed = true;
  while (changed) {
    changed = false;
    const add = (name: string) => {
      if (!aliases.has(name)) {
        aliases.add(name);
        changed = true;
      }
    };
    const collect = (node: ts.Node) => {
      if (
        ts.isImportSpecifier(node) &&
        (node.propertyName?.text ?? node.name.text) === "withSystemDb"
      )
        add(node.name.text);
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && access(node.initializer))
          add(node.name.text);
        if (ts.isObjectBindingPattern(node.name))
          for (const item of node.name.elements) {
            if (
              (item.propertyName?.getText(source) ??
                item.name.getText(source)) === "withSystemDb" &&
              ts.isIdentifier(item.name)
            )
              add(item.name.text);
          }
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  const calls: SystemCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && access(node.expression)) {
      let statement: ts.Node = node;
      while (statement.parent && !ts.isStatement(statement))
        statement = statement.parent;
      const comments =
        ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [];
      const nearby = comments
        .map((range) => text.slice(range.pos, range.end))
        .join("\n");
      const normalized = printer.printNode(
        ts.EmitHint.Unspecified,
        node,
        source,
      );
      calls.push({
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        fingerprint: createHash("sha256").update(normalized).digest("hex"),
        justified: substantiveJustification(nearby),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

export function baselineOf(calls: SystemCall[]): Baseline {
  const result: Baseline = {};
  for (const call of calls.filter((call) => !call.justified))
    (result[call.file] ??= []).push(call.fingerprint);
  for (const hashes of Object.values(result)) hashes.sort();
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Counts preserve duplicate calls. A new identical call cannot borrow one old exception. */
export function compareBaseline(actual: Baseline, allowed: Baseline): string[] {
  const errors: string[] = [];
  for (const [file, hashes] of Object.entries(actual)) {
    const remaining = [...(allowed[file] ?? [])];
    for (const hash of hashes) {
      const index = remaining.indexOf(hash);
      if (index < 0)
        errors.push(`${file}: unreviewed system bypass ${hash.slice(0, 12)}`);
      else remaining.splice(index, 1);
    }
  }
  return errors;
}

const isSource = (file: string) =>
  /^(apps|packages|tools)\//.test(file) &&
  /\.[cm]?[jt]sx?$/.test(file) &&
  !/(^|\/)(__tests__|test|tests|fixtures|integration|e2e)\//.test(file) &&
  !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
  !file.endsWith(".d.ts");
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}
function callsAt(ref?: string): SystemCall[] {
  let files: string[];
  if (ref) {
    let matches = "";
    try {
      matches = git(
        "grep",
        "-l",
        "-F",
        "withSystemDb",
        ref,
        "--",
        "apps",
        "packages",
        "tools",
      );
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
    }
    files = matches
      .trim()
      .split("\n")
      .map((file) => file.slice(ref.length + 1))
      .filter(isSource);
  } else
    files = git("ls-files", "--cached", "--others", "--exclude-standard")
      .trim()
      .split("\n")
      .filter(isSource);
  return [...new Set(files)].flatMap((file) =>
    scanSystemCalls(
      file,
      ref
        ? git("show", `${ref}:${file}`)
        : readFileSync(resolve(ROOT, file), "utf8"),
    ),
  );
}
function baseRef(): string {
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    ) as { pull_request?: { base: { sha: string } }; before?: string };
    if (event.pull_request) return event.pull_request.base.sha;
    if (event.before && !/^0+$/.test(event.before)) return event.before;
  }
  return "origin/main";
}
export function main(): number {
  const baseline = JSON.parse(
    readFileSync(resolve(ROOT, BASELINE_PATH), "utf8"),
  ) as Baseline;
  const ref = baseRef();
  const hasBaseline =
    git("ls-tree", "--name-only", ref, BASELINE_PATH).trim() !== "";
  // Initial adoption can grandfather only calls already on the target branch.
  const prior: Baseline = hasBaseline
    ? (JSON.parse(git("show", `${ref}:${BASELINE_PATH}`)) as Baseline)
    : baselineOf(callsAt(ref));
  const calls = callsAt();
  const actual = baselineOf(calls);
  const errors = [
    ...compareBaseline(baseline, prior),
    ...compareBaseline(actual, baseline),
  ];
  for (const error of compareBaseline(baseline, actual))
    errors.push(`${error} (stale baseline entry; remove it)`);
  if (errors.length) {
    for (const error of errors) console.error(error);
    for (const call of calls.filter((call) => !call.justified)) {
      if (
        errors.some(
          (error) =>
            error.startsWith(`${call.file}:`) &&
            error.includes(call.fingerprint.slice(0, 12)),
        )
      )
        console.error(
          `  ${call.file}:${call.line}: add a nearby tenancy: comment naming the scope fence or global/system purpose.`,
        );
    }
    return 1;
  }
  console.log(
    `check:system-db: ${calls.length} calls, ${Object.values(actual).flat().length} existing exceptions. The baseline may only shrink.`,
  );
  return 0;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = main();
