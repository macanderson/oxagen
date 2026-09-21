import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { readSkillFrontmatter } from "./skill-frontmatter";

describe("skill frontmatter", () => {
  it("decodes quoted fields and preserves body position with CRLF", () => {
    expect(
      readSkillFrontmatter(
        '---\r\nname: "release-notes"\r\nversion: "1.2.3"\r\n---\r\n# Body',
      ),
    ).toEqual({
      fields: { name: "release-notes", version: "1.2.3" },
      bodyStart: 4,
    });
  });
  it.each([
    "- name",
    "null",
    "name: first\nname: second",
    "name: &n value\nother: *n",
    "<<: {name: value}",
  ])("refuses ambiguous or non-mapping YAML %s", (yaml) => {
    expect(readSkillFrontmatter(`---\n${yaml}\n---`)).toBeNull();
  });
  it("retains structured and escaped permission keys for the grant check", () => {
    expect(
      readSkillFrontmatter(
        '---\n"permi\\u0073sions": {all: true}\n"allowed-tools": [shell]\n---',
      )?.fields,
    ).toEqual({ permissions: "", "allowed-tools": "" });
  });
});

it("keeps YAML outside the eager kernel and registry graph", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  function walk(file: string): void {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
        continue;
      const specifier = node.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      expect(specifier.text).not.toBe("yaml");
      if (!specifier.text.startsWith(".")) continue;
      const path = resolve(dirname(file), specifier.text);
      const target = [`${path}.ts`, resolve(path, "index.ts")].find(existsSync);
      if (target) walk(target);
    }
  }
  for (const entry of ["index.ts", "kernel.ts", "contracts/index.ts"])
    walk(resolve(root, entry));
  expect(seen.has(resolve(root, "skill-frontmatter.ts"))).toBe(false);
});
