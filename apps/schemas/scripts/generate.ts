/**
 * generate.ts — Regenerates `public/oxagen-cli-settings-schema.json` from the
 * canonical Zod schema (`oxagenSettingsSchema`, `apps/cli/src/settings/schema.ts`).
 *
 * Oxagen CLI's `settings.json` format is defined once, in Zod, so validation
 * and typing stay a single source of truth. This script is the *only* place
 * that projects that Zod schema into a standalone JSON Schema document — the
 * artifact editors (VS Code, JetBrains, etc.) fetch via `$schema` for
 * autocompletion. `src/schema-drift.test.ts` re-runs this same conversion in
 * CI and fails the build if the committed JSON falls out of sync with the
 * Zod source, so there is never a stale copy floating around.
 *
 * Run with `pnpm --filter @oxagen/schemas run settings:schema`.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
// Relative import straight to the CLI's TS source (no build step, no publish
// boundary) — @oxagen/cli does not export this module, so this is the
// intended way to reuse it. Extensionless per this repo's Turbopack-style
// import convention; tsx/vitest resolve the on-disk .ts file directly.
import { oxagenSettingsSchema } from "../../cli/src/settings/schema.js";

const SCHEMA_ID = "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json";

export function generateOxagenCliSettingsSchema(): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(oxagenSettingsSchema, {
    name: "OxagenCliSettings",
    $refStrategy: "none",
  });

  return {
    $id: SCHEMA_ID,
    title: "Oxagen CLI settings.json",
    description:
      "JSON Schema for the Oxagen CLI's settings.json configuration file — model, apiUrl, env, permissions, hooks, mcpServers, toolVisibility, and inline agents. Generated from the canonical Zod schema in apps/cli/src/settings/schema.ts; do not hand-edit.",
    ...jsonSchema,
  };
}

function main(): void {
  const outPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../public/oxagen-cli-settings-schema.json",
  );
  const schema = generateOxagenCliSettingsSchema();
  writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

// Only run when executed directly (tsx scripts/generate.ts), not when
// imported by the drift test.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
