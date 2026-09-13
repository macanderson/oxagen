/**
 * generate-built-in-templates.mjs
 *
 * Reads the authored built-in template YAML files and emits a statically
 * bundled TypeScript data module (src/built-in-templates.ts).
 *
 * Why this exists: the prompt-template registry is imported by client
 * components (e.g. the Command Menu's Quick Actions). A client bundle cannot
 * `require("node:fs")`, so the registry must NOT read its YAML sources from
 * disk at runtime. Instead, the YAML stays the human-authored source of truth
 * and this script bakes it into a plain-data `.ts` module that bundles cleanly
 * into both server and browser chunks (no node builtins, no loaders).
 *
 * Run:  pnpm --filter app generate:templates
 *
 * The drift between YAML and the generated module is guarded by a unit test
 * (built-in-templates.test.ts), so a forgotten regen fails CI rather than
 * silently shipping stale templates.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "../templates");
const OUT_FILE = resolve(__dirname, "../built-in-templates.ts");

/**
 * Deterministic file order: alphabetical by filename. Ranking is primarily by
 * route specificity, but ties fall back to registry insertion order — i.e. this
 * order — so it must stay stable. Alphabetical also keeps the generated file
 * diff-clean across regens.
 */
function builtinYamlFiles() {
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
}

function loadTemplates() {
  return builtinYamlFiles().map((file) => {
    const raw = readFileSync(resolve(TEMPLATES_DIR, file), "utf8");
    const parsed = parseYaml(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        `generate-built-in-templates: ${file} did not parse to an object`,
      );
    }
    return parsed;
  });
}

function emit(templates) {
  const banner = `/**
 * built-in-templates.ts — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source of truth: templates/*.yaml
 * Regenerate:      pnpm --filter app generate:templates
 *
 * Statically bundled so the prompt-template registry is browser-safe (no
 * runtime fs reads). Validated against promptTemplateSchema at registry load.
 */
import type { PromptTemplateInput } from "./schema";

export const BUILT_IN_TEMPLATES: PromptTemplateInput[] = ${JSON.stringify(templates, null, 2)};
`;
  writeFileSync(OUT_FILE, banner, "utf8");
}

const templates = loadTemplates();
emit(templates);
console.log(
  `generate-built-in-templates: wrote ${templates.length} templates → ${OUT_FILE}`,
);
