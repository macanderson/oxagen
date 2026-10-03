// The skill wizard renames an uploaded skill with renameSkillSource, and every
// other step reads its name with skillSourceName. Both go through one YAML
// module, @oxagen/oxagen/skill-frontmatter, so the rename and the reader agree
// on the name (#3657, carried in #3501). The first suite pins that agreement
// over the header shapes the reader accepts: the rename either writes a name
// the reader reads back, with every other field and the body unchanged, or it
// refuses. The second keeps a second YAML parser out of the app.
import { readFileSync } from "node:fs";
import path from "node:path";
import { readSkillFrontmatter } from "@oxagen/oxagen/skill-frontmatter";
import { describe, expect, it } from "vitest";
import {
  APP_DIR,
  importEdges,
  parse,
  productionFiles,
  readSource,
  WHOLE_TREE_TIMEOUT_MS,
} from "../test/arch/parse";
import { renameSkillSource, skillSourceName } from "./skill-source-identity";

const NEW_NAME = "renamed-skill";
const BODY = "# Release notes\n\nWrite the notes.\n";

/** Headers the reader accepts whose name the rename can replace in place. */
const RENAMED: readonly string[] = [
  "---\nname: old # keep\nversion: 1.0.0\n---\n",
  '---\nname: "a # b"\nversion: 1.0.0\n---\n',
  "---\nname: 'old' # k\r\nversion: 1.0.0\r\n---\r\n",
  "---\nname: old\n  more\nversion: 1.0.0\n---\n",
  "---\nname:\nversion: 1.0.0\n---\n",
  "---\nname: # c\nversion: 1.0.0\n---\n",
  '---\n"n\\u0061me": old\nversion: 1.0.0\n---\n',
  "---\r\nversion: 1.0.0\r\n---\r\n",
  "---\nversion: 1.0.0\nscope: workspace\nname: old-name\n---\n",
];

/** Headers the reader accepts whose name has no single-line value to replace. */
const REFUSED: readonly string[] = [
  "---\nname: |\n  old\nversion: 1.0.0\n---\n",
  "---\nname: [old]\nversion: 1.0.0\n---\n",
  "---\nname: {first: old}\nversion: 1.0.0\n---\n",
];

/** Every field the reader decodes except `name`. */
function otherFields(text: string): Record<string, string> | null {
  const fields = readSkillFrontmatter(text)?.fields;
  if (fields === undefined) return null;
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => key !== "name"),
  );
}

/** The lines after the closing fence, as the reader counts them. */
function bodyOf(text: string): string | null {
  const fm = readSkillFrontmatter(text);
  if (fm === null) return null;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(fm.bodyStart)
    .join("\n");
}

describe("renameSkillSource and the frontmatter reader", () => {
  it.each(RENAMED)("agree on the new name for %j", (header) => {
    const source = `${header}${BODY}`;
    expect(readSkillFrontmatter(source)).not.toBeNull();
    expect(bodyOf(source)).toBe(BODY);

    const renamed = renameSkillSource(source, NEW_NAME) ?? "";
    expect(readSkillFrontmatter(renamed)?.fields.name).toBe(NEW_NAME);
    expect(skillSourceName(renamed)).toBe(NEW_NAME);
    expect(otherFields(renamed)).toEqual(otherFields(source));
    expect(bodyOf(renamed)).toBe(BODY);
  });

  it.each(REFUSED)("refuses %j instead of writing a second reading", (header) => {
    const source = `${header}${BODY}`;
    expect(readSkillFrontmatter(source)).not.toBeNull();
    expect(renameSkillSource(source, NEW_NAME)).toBeNull();
  });

  it("refuses a folded name the reader reads as valid", () => {
    // The reader decodes this name as `old-name`. The rename has no single
    // line to replace, so it refuses rather than write a header the reader
    // could read another way.
    const source = `---\nname: >-\n  old-name\nversion: 1.0.0\n---\n${BODY}`;
    expect(skillSourceName(source)).toBe("old-name");
    expect(renameSkillSource(source, NEW_NAME)).toBeNull();
  });
});

/** YAML parsers on npm. The app reads skill headers through the shared module alone. */
const YAML_PARSERS: readonly string[] = [
  "yaml",
  "js-yaml",
  "gray-matter",
  "front-matter",
  "yaml-front-matter",
  "@std/yaml",
];

function isYamlParser(specifier: string): boolean {
  return YAML_PARSERS.some(
    (parser) => specifier === parser || specifier.startsWith(`${parser}/`),
  );
}

describe("one YAML parser for skill headers", () => {
  it(
    "imports no YAML parser in any production module of the app",
    () => {
      const files = productionFiles();
      expect(files).toContain("src/shared/skill-source-identity.ts");
      const found: string[] = [];
      for (const file of files) {
        for (const edge of importEdges(parse(readSource(file)))) {
          if (isYamlParser(edge.specifier))
            found.push(`${file}:${String(edge.line)} ${edge.specifier}`);
        }
      }
      expect(found).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("declares no YAML parser as an app dependency", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(APP_DIR, "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(isYamlParser)).toEqual([]);
  });
});
