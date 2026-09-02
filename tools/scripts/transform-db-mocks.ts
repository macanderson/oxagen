/**
 * Transforms vi.mock("@oxagen/database", ...) blocks in test files to:
 *   1. Use importOriginal + spread real exports (includes real schema)
 *   2. Use real.makeWithTenantDbMock / real.makeWithSystemDbMock
 *   3. Remove redundant inline `schema: { ... }` literal stubs
 *
 * Usage: tsx tools/scripts/transform-db-mocks.ts [file1 file2 ...]
 */

import { readFileSync, writeFileSync } from "fs";

const ASYNC_HEADER = `async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
  ...real,`;

const FOOTER_REPLACEMENT = `  };
})`;

/** Return position right after the closing paren of a balanced paren group starting at pos */
function findParenEnd(src: string, pos: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = pos; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === inStr && src[i - 1] !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Return position right after the closing brace matching the `{` at pos */
function findBraceEnd(src: string, pos: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = pos; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === inStr && src[i - 1] !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Remove `schema: { ... },` blocks that use literal string sentinels.
 * Keeps `schema: IDENTIFIER` or `schema: IDENTIFIER.prop` (variable references).
 */
function removeSchemaLiteral(inner: string): string {
  // Match `schema:` followed by optional whitespace + `{`
  // but NOT `schema: someIdentifier` (no literal brace)
  const schemaRe = /(\n[ \t]*)schema:\s*\{/g;
  let result = inner;
  let match: RegExpExecArray | null;
  // Process last-to-first to preserve positions
  const positions: Array<{ start: number; end: number; indent: string }> = [];
  while ((match = schemaRe.exec(inner)) !== null) {
    const bracePos = match.index + match[0].length - 1; // position of `{`
    const braceEnd = findBraceEnd(inner, bracePos);
    if (braceEnd === -1) continue;
    // After the closing brace, consume optional whitespace + comma
    let end = braceEnd;
    while (end < inner.length && /[ \t]/.test(inner[end]!)) end++;
    if (inner[end] === ",") end++;
    positions.push({ start: match.index, end, indent: match[1]! });
  }
  // Remove from last to first
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i]!;
    result = result.slice(0, p.start) + result.slice(p.end);
  }
  return result;
}

/**
 * Replace simple withTenantDb / withSystemDb inline patterns with makeWithXxxDbMock.
 *
 * Handles single-line patterns like:
 *   withTenantDb: async (fn: ComplexType) => fn(IDENT),
 *
 * IDENT must be a simple variable name (letters/digits/underscore/dot, no parens).
 * Skips multi-line bodies and function-call arguments like `fn(makeTx())`.
 */
function replaceSimpleDbWrapper(inner: string): string {
  // Use [^\n]* to match the full parameter list (handles nested type parens on one line).
  // The last `) => fn(IDENT)` is the arrow-function we want to replace.
  const tenantRe =
    /withTenantDb:[^\n]*\)\s*=>\s*fn\(([a-zA-Z_][a-zA-Z0-9_.]*)\)/g;
  const systemRe =
    /withSystemDb:[^\n]*\)\s*=>\s*fn\(([a-zA-Z_][a-zA-Z0-9_.]*)\)/g;

  let result = inner;
  result = result.replace(tenantRe, (_m, ident: string) => {
    // Skip if ident is a function call
    if (ident.endsWith(")") || ident.includes("(")) return _m;
    return `withTenantDb: real.makeWithTenantDbMock(${ident})`;
  });
  result = result.replace(systemRe, (_m, ident: string) => {
    if (ident.endsWith(")") || ident.includes("(")) return _m;
    return `withSystemDb: real.makeWithSystemDbMock(${ident})`;
  });
  return result;
}

function transformObjectLiteralFactory(mockBlock: string): {
  transformed: string;
  changed: boolean;
} {
  // Pattern: vi.mock("@oxagen/database", () => ({
  //   ...
  // }));
  const headerRe = /vi\.mock\("@oxagen\/database",\s*\(\)\s*=>\s*\(\{/;
  const m = headerRe.exec(mockBlock);
  if (!m) return { transformed: mockBlock, changed: false };

  // Find where the inner object starts (after `({`)
  const innerStart = m.index + m[0].length;

  // Find the matching closing `}))` — the object's `}` + `)` + `)` + `;`
  // We track brace depth from innerStart - 1 (the `{`)
  const braceOpenPos = innerStart - 1;
  const braceEndPos = findBraceEnd(mockBlock, braceOpenPos);
  if (braceEndPos === -1) return { transformed: mockBlock, changed: false };

  // The inner content is between braceOpenPos+1 and braceEndPos-1
  let inner = mockBlock.slice(braceOpenPos + 1, braceEndPos - 1);

  // Process inner content
  inner = removeSchemaLiteral(inner);
  inner = replaceSimpleDbWrapper(inner);

  // Build the replacement
  // Before: vi.mock("@oxagen/database", () => ({  INNER  }));
  // After:  vi.mock("@oxagen/database", async (importOriginal) => {
  //           const real = ...;
  //           return {
  //             ...real,
  //             INNER
  //           };
  //         });

  const prefix = mockBlock.slice(0, m.index);

  // The suffix after `}` should be `))`+optional `;` — trim it
  // braceEndPos points just after `}`, next chars should be `));` or `));\n`
  const closingPart = mockBlock.slice(braceEndPos, braceEndPos + 3);
  const hasSemicolon = closingPart.includes(";");
  const realSuffix = mockBlock.slice(braceEndPos + (hasSemicolon ? 3 : 2));

  const indentMatch = /^([ \t]*)vi\.mock/m.exec(mockBlock.slice(m.index));
  const indent = indentMatch ? indentMatch[1] : "";

  const transformed =
    prefix +
    `vi.mock("@oxagen/database", ${ASYNC_HEADER}` +
    inner +
    `\n${indent}${FOOTER_REPLACEMENT}` +
    (hasSemicolon ? ";" : "") +
    realSuffix;

  return { transformed, changed: true };
}

function transformExplicitReturnFactory(mockBlock: string): {
  transformed: string;
  changed: boolean;
} {
  // Pattern: vi.mock("@oxagen/database", () => {
  //   ...
  //   return { ... };
  // });
  const headerRe = /vi\.mock\("@oxagen\/database",\s*\(\)\s*=>\s*\{/;
  const m = headerRe.exec(mockBlock);
  if (!m) return { transformed: mockBlock, changed: false };

  // Change `() => {` to `async (importOriginal) => {` and inject const real line
  let transformed = mockBlock.replace(
    /vi\.mock\("@oxagen\/database",\s*\(\)\s*=>\s*\{/,
    `vi.mock("@oxagen/database", async (importOriginal) => {\n  const real = await importOriginal<typeof import("@oxagen/database")>();`,
  );

  // Find `return {` and inject `...real,` after it
  transformed = transformed.replace(
    /return\s*\{(\s*)/,
    (_m, ws: string) => `return {\n    ...real,${ws}`,
  );

  // Remove schema literal block
  const retStart = transformed.indexOf("return {");
  if (retStart !== -1) {
    const retObjStart = transformed.indexOf("{", retStart);
    const retObjEnd = findBraceEnd(transformed, retObjStart);
    if (retObjEnd !== -1) {
      let inner = transformed.slice(retObjStart + 1, retObjEnd - 1);
      inner = removeSchemaLiteral(inner);
      inner = replaceSimpleDbWrapper(inner);
      transformed =
        transformed.slice(0, retObjStart + 1) +
        inner +
        transformed.slice(retObjEnd - 1);
    }
  }

  return { transformed, changed: true };
}

function transformFile(path: string): boolean {
  const original = readFileSync(path, "utf-8");
  let content = original;
  let anyChanged = false;

  // Find all vi.mock("@oxagen/database", ...) occurrences
  const mockRe = /vi\.mock\("@oxagen\/database",/g;
  let match: RegExpExecArray | null;
  const occurrences: number[] = [];
  while ((match = mockRe.exec(content)) !== null) {
    occurrences.push(match.index);
  }

  // Process from last to first to preserve positions
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const start = occurrences[i]!;
    const end = findParenEnd(content, start + "vi.mock(".length - 1);
    if (end === -1) continue;
    // Include optional trailing `;`
    const trailingEnd = content[end] === ";" ? end + 1 : end;
    const mockBlock = content.slice(start, trailingEnd);

    // Skip if already using importOriginal (already transformed)
    if (mockBlock.includes("importOriginal")) continue;

    let result: { transformed: string; changed: boolean };
    if (/\(\)\s*=>\s*\(\{/.test(mockBlock)) {
      result = transformObjectLiteralFactory(mockBlock);
    } else if (/\(\)\s*=>\s*\{/.test(mockBlock)) {
      result = transformExplicitReturnFactory(mockBlock);
    } else {
      continue;
    }

    if (result.changed) {
      content =
        content.slice(0, start) +
        result.transformed +
        content.slice(trailingEnd);
      anyChanged = true;
    }
  }

  if (anyChanged) {
    writeFileSync(path, content, "utf-8");
  }
  return anyChanged;
}

// Main
const files = process.argv.slice(2);
let changed = 0;
let unchanged = 0;
let errors = 0;

for (const f of files) {
  try {
    if (transformFile(f)) {
      console.log(`✓ ${f}`);
      changed++;
    } else {
      unchanged++;
    }
  } catch (e) {
    console.error(`✗ ${f}: ${e}`);
    errors++;
  }
}

console.log(
  `\nDone: ${changed} changed, ${unchanged} unchanged, ${errors} errors`,
);
