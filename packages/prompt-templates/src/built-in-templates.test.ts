/**
 * built-in-templates.test.ts — drift guard.
 *
 * built-in-templates.ts is generated from src/templates/*.yaml by
 * scripts/generate-built-in-templates.mjs and statically bundled so the
 * registry stays browser-safe (no runtime node:fs). This test re-reads the YAML
 * sources (Node test env — fs is available here) and asserts the generated
 * module is in sync, so an edit to a YAML without a regen fails CI rather than
 * silently shipping stale Quick Actions.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, it, expect } from "vitest";
import { BUILT_IN_TEMPLATES } from "./built-in-templates";
import { promptTemplateSchema } from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "templates");

function readYamlTemplatesFromDisk(): unknown[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) =>
      parseYaml(readFileSync(resolve(TEMPLATES_DIR, file), "utf8")),
    );
}

describe("built-in-templates (generated)", () => {
  it("matches the authored YAML sources (regenerate if this fails: pnpm --filter @oxagen/prompt-templates generate:templates)", () => {
    expect(BUILT_IN_TEMPLATES).toEqual(readYamlTemplatesFromDisk());
  });

  it("contains exactly the YAML files on disk", () => {
    const yamlCount = readdirSync(TEMPLATES_DIR).filter((f) =>
      f.endsWith(".yaml"),
    ).length;
    expect(BUILT_IN_TEMPLATES.length).toBe(yamlCount);
  });

  it("every generated template satisfies promptTemplateSchema", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      expect(() => promptTemplateSchema.parse(template)).not.toThrow();
    }
  });

  it("template ids are unique", () => {
    const ids = BUILT_IN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers no runtime node:fs dependency in the bundled module", () => {
    // The whole point of this module: it is plain data, importable by client
    // components. If the generated file ever imports a node builtin, this fails.
    const src = readFileSync(
      resolve(__dirname, "built-in-templates.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']node:/);
  });
});
