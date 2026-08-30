/**
 * generate.ts — Regenerates `public/oxagen-cli-settings-schema.json` from the
 * canonical Zod schema (`oxagenSettingsSchema`, `apps/cli/src/settings/schema.ts`).
 *
 * Oxagen CLI's `settings.json` format is defined once, in Zod, so validation
 * and typing stay a single source of truth. This script is the *only* place
 * that projects that Zod schema into a standalone JSON Schema document — the
 * artifact editors (VS Code, JetBrains, etc.) fetch via `$schema` for
 * autocompletion.
 *
 * `src/schema-drift.test.ts` re-runs this same conversion and fails if the
 * committed JSON no longer matches the Zod source. Note that the check is not
 * airtight in CI: this package declares no dependency on `@oxagen/cli`, so a
 * PR touching only `apps/cli/src/settings/schema.ts` never marks it affected,
 * and Turborepo's hash does not include the CLI source either. Re-run the
 * generator by hand after editing `oxagenSettingsSchema`. See the README.
 *
 * That undeclared edge cuts both ways: the relative import below resolves
 * `@oxagen/mcp-config/schema` (imported by the CLI file) out of
 * `apps/cli/node_modules`, so this script only works when the CLI package's
 * dependencies are installed too. A workspace-wide `pnpm i` gives you that; a
 * single-package install does not.
 *
 * Run with `pnpm --filter @oxagen/schemas run settings:schema`.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
// Relative import straight to the CLI's TS source (no build step, no publish
// boundary) — @oxagen/cli does not export this module, so this is the
// intended way to reuse it. The `.js` suffix is the ESM/NodeNext convention;
// tsx and vitest both resolve it to the on-disk `.ts` file.
import { oxagenSettingsSchema } from "../../cli/src/settings/schema.js";

const SCHEMA_ID = "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json";

export function generateOxagenCliSettingsSchema(): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(oxagenSettingsSchema, {
    name: "OxagenCliSettings",
    $refStrategy: "none",
  });

  // `name` makes zod-to-json-schema emit `{ $ref: "#/definitions/…",
  // definitions: { … } }`, so the root object below carries a `$ref`. Under
  // draft-07 — which the generated `$schema` declares — a validator ignores
  // every keyword sitting next to a `$ref`, so `title` and `description` here
  // are decoration that strict consumers drop. Editors resolve the `$ref` and
  // still autocomplete correctly.
  return {
    $id: SCHEMA_ID,
    title: "Oxagen CLI settings.json",
    // Deliberately does NOT list the fields: the Zod source owns that list and
    // has already outgrown one hand-written enumeration here.
    description:
      "JSON Schema for the Oxagen CLI's settings.json configuration file. Generated from the canonical Zod schema in apps/cli/src/settings/schema.ts; do not hand-edit.",
    ...jsonSchema,
  };
}

/** Canonical on-disk location of the committed artifact that `schemas.oxagen.sh` serves. */
export function defaultSchemaOutPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../public/oxagen-cli-settings-schema.json",
  );
}

/**
 * Regenerate the JSON Schema artifact and write it to `outPath` (defaults to
 * the committed public path). Returns the path written so callers/CLI can log
 * it.
 *
 * These bytes are NOT the bytes committed in `public/`. `JSON.stringify` puts
 * every array element on its own line; Biome (the repo formatter, ADR-015)
 * then collapses short arrays back onto one line, and the pre-commit hook
 * re-stages that. So a regen shows a large whitespace-only `git diff` until
 * you commit. Compare the parsed JSON, never the raw bytes — which is exactly
 * what the drift test does.
 */
export function writeOxagenCliSettingsSchema(
  outPath: string = defaultSchemaOutPath(),
): string {
  const schema = generateOxagenCliSettingsSchema();
  writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  return outPath;
}

// Only run when executed directly (tsx scripts/generate.ts), not when imported
// by the drift test. This process-entry guard cannot be exercised in-process by
// the unit tests, so it is excluded from coverage; the behaviour it triggers
// (writeOxagenCliSettingsSchema) is covered directly.
/* v8 ignore start */
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  console.log(`Wrote ${writeOxagenCliSettingsSchema()}`);
}
/* v8 ignore stop */
