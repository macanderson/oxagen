/**
 * ADR-235: the binding that marks a call as Stella's has exactly two
 * producers, and both are Stella's own path.
 *
 * The kernel refuses a binding its registry does not hold
 * (kernel.decision-rules.test.ts), which stops a forgery. It does not stop a
 * surface from minting a real binding for a request it serves. That mistake
 * would let any API key, MCP client, or wrapped agent skip the workspace's
 * decision rules with no forgery at all. So this walks the source tree and
 * asserts where the minting function may appear. `*.test.ts` files are
 * excluded.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { IN_APP_AGENT_SURFACES } from "../contracts/run.list";

/** Repo root: packages/oxagen/src/test/<this file> → four levels up. */
const REPO_ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** The minting function this test governs. */
const MINT = "createOxagenAssistantBinding";

/**
 * The only files outside packages/oxagen allowed to name it: Stella's turn,
 * and the resume of a call one of its turns parked.
 */
const ALLOWED = new Set([
  "packages/agent/src/runtime/assistant-turn.ts",
  "packages/agent/src/runtime/approval-resume.ts",
]);

/** The package that owns the binding; everything under it is exempt. */
const OWNING_PACKAGE = "packages/oxagen";

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".git",
]);

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walk(full, out);
      continue;
    }
    // A test may spell the name, to mint a binding for a kernel test or to
    // assert a builder never carries one.
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/** Every apps/<app>/src and packages/<pkg>/src directory that exists. */
function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(REPO_ROOT, group);
    let members: string[];
    try {
      members = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const member of members) {
      if (SKIP_DIRS.has(member)) continue;
      const src = join(groupDir, member, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // A workspace member with no src/ (apps/web is hand-authored HTML).
      }
    }
  }
  return roots;
}

/** Repo-relative, forward-slashed, so an assertion message names a real path. */
function repoPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

function filesNaming(name: string, files: string[]): string[] {
  return files
    .filter((file) => readFileSync(file, "utf8").includes(name))
    .map(repoPath)
    .sort();
}

describe("ADR-235: only Stella's path mints the Stella binding", () => {
  const roots = sourceRoots();
  const files = walk(join(REPO_ROOT, "tools", "scripts"), []).concat(
    ...roots.map((root) => walk(root, [])),
  );

  it("walks a tree that holds the binding module and both producers", () => {
    const paths = files.map(repoPath);
    expect(paths).toContain("packages/oxagen/src/oxagen-assistant.ts");
    for (const allowed of ALLOWED) expect(paths).toContain(allowed);
    expect(paths.length).toBeGreaterThan(100);
  });

  it("names the minting function outside packages/oxagen only in Stella's turn and its resume", () => {
    const outside = filesNaming(MINT, files).filter(
      (path) => !path.startsWith(`${OWNING_PACKAGE}/`),
    );
    expect(outside).toEqual([...ALLOWED].sort());
  });

  it("finds the minting function in no surface's context builder", () => {
    const surfaces = filesNaming(MINT, files).filter(
      (path) =>
        path.startsWith("apps/api/") ||
        path.startsWith("apps/mcp/") ||
        path.startsWith("apps/cli/") ||
        path.startsWith("packages/tacho/"),
    );
    expect(surfaces).toEqual([]);
  });
});

/**
 * Mac's ruling of 2026-10-01 has two halves. Oxagen's in-app assistant is
 * outside workspace governance. The open-source Stella coding agent a
 * customer runs as a CLI is a customer agent, governed and monitored exactly
 * like Claude Code and Codex. The two share a name, so the exemption must key
 * on the kernel-minted binding and the in-app run surfaces, never on the word
 * "stella". A wrapped session's harness or runtime is `stella`, and a check
 * that read that name would exempt the customer's agent.
 *
 * This prints each piece of exemption code without its comments and asserts
 * the word appears nowhere in it.
 */
describe("ADR-235: the exemption never keys on the name stella", () => {
  const printer = ts.createPrinter({ removeComments: true });
  const parse = (path: string) =>
    ts.createSourceFile(
      path,
      readFileSync(join(REPO_ROOT, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
  const printed = (node: ts.Node, source: ts.SourceFile) =>
    printer.printNode(ts.EmitHint.Unspecified, node, source);
  const functionNamed = (path: string, name: string): string => {
    const source = parse(path);
    let found: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
        (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === name)
      )
        found = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (found === undefined) throw new Error(`${name} not found in ${path}`);
    return printed(found, source);
  };

  it.each([
    ["packages/oxagen/src/oxagen-assistant.ts", "createOxagenAssistantBinding"],
    ["packages/oxagen/src/oxagen-assistant.ts", "isKernelIssuedOxagenAssistant"],
    ["packages/oxagen/src/oxagen-assistant.ts", "isOxagenAssistantCall"],
    ["packages/oxagen/src/kernel.ts", "skipWorkspaceRules"],
    ["packages/oxagen/src/kernel.ts", "forgedBinding"],
    ["packages/agent/src/runtime/assistant-turn.ts", "assistantBindingFor"],
    ["packages/agent/src/handlers/_agent-identity.ts", "runFiguresByAgent"],
  ])("%s `%s` names no stella", (path, name) => {
    const code = functionNamed(path, name);
    // The walk found real code, so the assertion below proves something.
    expect(code.length).toBeGreaterThan(20);
    expect(code).not.toMatch(/stella/i);
  });

  it("prints the whole kernel without the word outside its comments", () => {
    const kernel = printer.printFile(parse("packages/oxagen/src/kernel.ts"));
    expect(kernel).toContain("skipWorkspaceRules");
    expect(kernel).not.toMatch(/stella/i);
  });

  it("excludes exactly the two in-app run surfaces, neither a harness name", () => {
    expect([...IN_APP_AGENT_SURFACES]).toEqual(["chat", "api-chat"]);
  });
});
