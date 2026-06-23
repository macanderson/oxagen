// Generates src/built-in-templates.ts from src/templates/*.yaml.
//
// The registry must be importable from a "use client" component (the ⌘K
// Command Menu), so it cannot read YAML from node:fs at runtime — Turbopack
// would try to bundle node:fs into the browser chunk and the build fails.
// We therefore parse the YAML at build/author time and inline the data as a
// plain static TS array. The `yaml` dependency stays dev-only.
//
// Regenerate after editing any template: pnpm --filter @oxagen/prompt-templates generate:templates
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(here, "../src/templates");

// Explicit order = stable, reviewable registry order.
const FILES = [
  "summarize-run-failure.yaml",
  "show-similar-failed-runs.yaml",
  "open-source-playbook.yaml",
  "create-trigger-for-event.yaml",
  "connect-data-source.yaml",
  "invite-teammate.yaml",
  "explain-audit-event.yaml",
  "run-this-playbook.yaml",
  "why-is-trigger-failing.yaml",
  "summarize-workspace-activity.yaml",
];

const data = FILES.map((f) => parseYaml(readFileSync(resolve(templatesDir, f), "utf8")));

const out = `// AUTO-GENERATED from src/templates/*.yaml by scripts/generate-builtins.mjs — DO NOT EDIT BY HAND.
// Regenerate after editing a template: pnpm --filter @oxagen/prompt-templates generate:templates
//
// Inlined as static data (not read from node:fs at runtime) so this module is
// safe to import from a "use client" component without pulling Node built-ins
// into the browser bundle. Typed as unknown[]; validated by promptTemplateSchema
// at registry load in index.ts.

export const BUILTIN_TEMPLATE_DATA: unknown[] = ${JSON.stringify(data, null, 2)};
`;

writeFileSync(resolve(here, "../src/built-in-templates.ts"), out);
console.log(`generate-builtins: wrote ${data.length} templates to src/built-in-templates.ts`);
