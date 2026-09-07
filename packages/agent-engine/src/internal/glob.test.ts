import { describe, it, expect } from "vitest";
import { globToRegExp } from "./glob";

describe("globToRegExp", () => {
  it("matches a simple literal path exactly", () => {
    const re = globToRegExp("foo.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("bar.ts")).toBe(false);
    expect(re.test("foo.tsx")).toBe(false);
  });

  it("* matches any chars within a single segment", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/bar.ts")).toBe(true);
    expect(re.test("src/sub/foo.ts")).toBe(false);
  });

  it("** matches across multiple path segments", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a/b/c.ts")).toBe(true);
    expect(re.test("src/x.ts")).toBe(true);
    expect(re.test("lib/x.ts")).toBe(false);
  });

  it("** without trailing / is still greedy", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a/b/c.ts")).toBe(true);
    expect(re.test("x.ts")).toBe(true);
  });

  it("`**/x` matches x at the root, not only in a subdirectory (#1387)", () => {
    // #1387 stays open for the other half it asks for: one implementation,
    // shared, with the copies deleted. Until then this pins the semantics so a
    // copy cannot drift while it waits.
    // The `/` after `**` is consumed rather than emitted, so the pattern does
    // not require a separator. A copy of this function that emitted it lived in
    // the CLI's permission broker and decided allow/ask/deny, where `**/.env`
    // silently stopped covering the workspace root — the one `.env` a deny rule
    // is written for. That copy is gone; this pins the semantics it diverged
    // from, for each subject the issue reported.
    for (const [pattern, root, nested] of [
      ["**/.env", ".env", "config/.env"],
      ["**/secrets.txt", "secrets.txt", "a/b/secrets.txt"],
      ["**/*.pem", "key.pem", "certs/key.pem"],
    ] as const) {
      const re = globToRegExp(pattern);
      expect(re.test(root)).toBe(true);
      expect(re.test(nested)).toBe(true);
    }
  });

  it("? matches exactly one non-separator character (line 19 branch)", () => {
    const re = globToRegExp("src/?.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/ab.ts")).toBe(false);
    // slash is not matched by ?
    expect(re.test("src//a.ts")).toBe(false);
  });

  it("escapes regex special characters (dot, plus, brackets)", () => {
    // Dot in literal pattern should not act as wildcard
    const re = globToRegExp("a.b");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
  });

  it("matches files in the root with no directory prefix", () => {
    const re = globToRegExp("*.json");
    expect(re.test("package.json")).toBe(true);
    expect(re.test("tsconfig.json")).toBe(true);
    expect(re.test("src/package.json")).toBe(false);
  });
});
