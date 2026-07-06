// tools-shared.ts
//
// Pure, dependency-free predicates shared between the generic workspace tools
// (tools.ts) and the deterministic structured tools (tools-structured/). Kept in
// its own module so tools-structured can reuse them without importing tools.ts
// (which imports tools-structured — a cycle we avoid by putting the shared leaf
// here). tools.ts re-exports `isTestPath` so its existing public surface is
// unchanged.

/** Directory-name path segments that mark everything beneath them as test code. */
const TEST_DIR_NAMES = new Set(["tests", "test", "__tests__"]);

/** Basename patterns, matched against the lowercased filename only. */
const TEST_BASENAME_PATTERNS: RegExp[] = [
  /^test_.*\.py$/, // test_*.py
  /_test\.py$/, // *_test.py
  /^conftest\.py$/, // conftest.py
  /\.test\.(ts|tsx|js|jsx)$/, // *.test.ts(x) / *.test.js(x)
  /\.spec\.(ts|tsx|js|jsx)$/, // *.spec.ts(x) / *.spec.js(x)
  /_spec\.rb$/, // *_spec.rb
  /test\.java$/, // *Test.java
  /_test\.go$/, // *_test.go
];

/**
 * True when `relPath` looks like a test file, by directory convention
 * (`tests/`, `test/`, `__tests__/` anywhere in the path) or by filename
 * convention (`test_*.py`, `*.test.ts`, `*_spec.rb`, …). Case-insensitive;
 * matches anywhere in the path, whether absolute or repo-relative. Pure.
 */
export function isTestPath(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((seg) => TEST_DIR_NAMES.has(seg))) return true;
  return TEST_BASENAME_PATTERNS.some((re) => re.test(basename));
}
