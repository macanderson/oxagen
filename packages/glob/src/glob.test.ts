import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "./glob";

/**
 * The table #1387 asked for. Four packages each carried their own copy of this
 * function and nothing compared them, so the one that had drifted was found by
 * reading, months later, and only because it was the copy deciding
 * `allow | deny`.
 *
 * Every row is [pattern, path, expected]. Add a row here rather than a case
 * beside a call site: this file is the only place the semantics are written
 * down, and a rule that is not in it is a rule nothing holds.
 */
const TABLE: ReadonlyArray<readonly [string, string, boolean]> = [
  // `**` then a separator matches nothing as happily as it matches segments.
  // This is the row the drifted copy failed, and the reason it mattered.
  ["**/.env", ".env", true],
  ["**/.env", "config/.env", true],
  ["**/.env", "a/b/c/.env", true],
  ["**/*.pem", "key.pem", true],
  ["**/*.pem", "certs/key.pem", true],
  ["**/secrets.txt", "secrets.txt", true],

  // ...but it does not swallow the segment boundary. A rule about `.env` must
  // not reach a file that merely ends in those characters.
  ["**/.env", "foo.env", false],
  ["**/secrets.txt", "my-secrets.txt", false],

  // A single star stays inside one segment.
  ["*.ts", "index.ts", true],
  ["*.ts", "src/index.ts", false],
  ["src/*.ts", "src/index.ts", true],
  ["src/*.ts", "src/a/index.ts", false],
  ["src/*/index.ts", "src/a/index.ts", true],
  ["src/*/index.ts", "src/index.ts", false],

  // `**` on its own crosses everything, including separators.
  ["src/**", "src/a/b/c.ts", true],
  ["src/**/*.ts", "src/a/b/c.ts", true],
  ["src/**/*.ts", "src/x.ts", true],
  ["src/**/*.ts", "lib/x.ts", false],
  ["**/*.ts", "x.ts", true],
  ["*.json", "package.json", true],
  ["*.json", "src/package.json", false],
  ["foo.ts", "foo.ts", true],
  ["foo.ts", "bar.ts", false],
  ["foo.ts", "foo.tsx", false],
  ["**", "anything/at/all", true],
  ["**/node_modules/**", "a/node_modules/b/c", true],

  // `?` is one character and never a separator.
  ["a?c", "abc", true],
  ["a?c", "ac", false],
  ["a?c", "a/c", false],
  ["src/?.ts", "src/a.ts", true],
  ["src/?.ts", "src/ab.ts", false],
  ["src/?.ts", "src//a.ts", false],

  // Anchored at both ends.
  ["src/x", "src/x", true],
  ["src/x", "a/src/x", false],
  ["src/x", "src/x/y", false],

  // Regex metacharacters are literal, not operators. Without the escape,
  // `a.b` would match `axb` and `a+` would be a quantifier over `a`.
  ["a.b", "a.b", true],
  ["a.b", "axb", false],
  ["a+b", "a+b", true],
  ["a(b)", "a(b)", true],
  ["a[b]", "a[b]", true],
  ["a$b", "a$b", true],

  // No brace expansion and no character class: those patterns are literal.
  ["{a,b}.ts", "a.ts", false],
  ["{a,b}.ts", "{a,b}.ts", true],
];

describe("globToRegExp: the shared semantics table (#1387)", () => {
  for (const [pattern, path, expected] of TABLE) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(globToRegExp(pattern).test(path)).toBe(expected);
      expect(matchesGlob(pattern, path)).toBe(expected);
    });
  }
});

describe("globToRegExp: shape", () => {
  it("anchors both ends", () => {
    const re = globToRegExp("a");
    expect(re.source.startsWith("^")).toBe(true);
    expect(re.source.endsWith("$")).toBe(true);
  });

  it("compiles an empty pattern to a matcher for the empty string only", () => {
    expect(matchesGlob("", "")).toBe(true);
    expect(matchesGlob("", "a")).toBe(false);
  });

  it("returns a fresh RegExp per call, so `lastIndex` cannot leak between callers", () => {
    expect(globToRegExp("a")).not.toBe(globToRegExp("a"));
  });
});
