#!/usr/bin/env tsx
/**
 * check-connector-schemas.ts — verify that every connector registered in the
 * ingestion package has a corresponding schema.yaml, and that no built-in
 * schema.yaml exists on disk that is missing from BUILT_IN_PLUGIN_IDS.
 *
 * OXA-1784 — Connector schema.yaml coverage + alignment gate.
 *
 * Strategy:
 *   1. For each id in BUILT_IN_PLUGIN_IDS, assert that the schema.yaml file
 *      exists on disk AND that loadBuiltInSchema() can load it (valid YAML,
 *      correct shape, metadata.id matches).
 *   2. Scan the connectors/ directory for subdirectories that contain a
 *      schema.yaml but whose directory name (= expected plugin id) is NOT in
 *      BUILT_IN_PLUGIN_IDS — flag these as unregistered.
 *   3. Collect all connectorIds from the TypeScript connector source files
 *      (static analysis of `connectorId: "…"` assignments) and flag any that
 *      are not in BUILT_IN_PLUGIN_IDS.
 *
 * Exit codes:
 *   0 — all checks pass.
 *   1 — one or more gaps detected (missing schema, unregistered yaml, or
 *       registered connector not in built-in set).
 *   2 — script-level error (import failure, directory not found, etc.).
 *
 * Run from the monorepo root:
 *   pnpm check:connector-schemas
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Resolve paths ────────────────────────────────────────────────────────────

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const connectorsDir = resolve(
  repoRoot,
  "packages",
  "ingestion",
  "src",
  "connectors",
);

// ── Minimal shape for loaded schema (mirrors LoadedConnectorSchema) ──────────

interface AuthScheme {
  id: string;
  kind: string;
  fields?: { key: string; label: string }[];
}

interface SchemaField {
  key: string;
  label: string;
}

interface LoadedSchema {
  apiVersion: string;
  kind: string;
  metadata: {
    id: string;
    displayName: string;
    version: string;
    schemaVersion: string;
    publisher: { name: string; verified: boolean };
  };
  auth?: { schemes: AuthScheme[] };
  config?: { fields: SchemaField[] };
}

// ── Import live exports from connector-schema-loader ─────────────────────────

interface SchemaLoaderModule {
  BUILT_IN_PLUGIN_IDS: Set<string>;
  loadBuiltInSchema: (id: string) => LoadedSchema | null;
}

const loaderPath = resolve(
  repoRoot,
  "packages",
  "ingestion",
  "src",
  "connector-schema-loader.ts",
);

const { BUILT_IN_PLUGIN_IDS, loadBuiltInSchema } = (await import(
  loaderPath
).catch((err: unknown) => {
  console.error(
    "check-connector-schemas: failed to import connector-schema-loader:",
    err,
  );
  process.exit(2);
})) as SchemaLoaderModule;

// ── Helpers ──────────────────────────────────────────────────────────────────

interface CheckError {
  kind:
    | "missing_schema_file"
    | "load_failed"
    | "id_mismatch"
    | "invalid_shape"
    | "unregistered_yaml"
    | "connector_not_in_built_in";
  pluginId: string;
  detail?: string;
}

const errors: CheckError[] = [];

// ── Check 1: every id in BUILT_IN_PLUGIN_IDS has a valid schema file ─────────

console.log(
  `\ncheck-connector-schemas: verifying ${BUILT_IN_PLUGIN_IDS.size} built-in plugin id(s)…\n`,
);

for (const id of BUILT_IN_PLUGIN_IDS) {
  const schemaPath = resolve(connectorsDir, id, "schema.yaml");

  // 1a. File must exist.
  if (!existsSync(schemaPath)) {
    errors.push({
      kind: "missing_schema_file",
      pluginId: id,
      detail: `Expected: ${schemaPath}`,
    });
    continue;
  }

  // 1b. loadBuiltInSchema must succeed.
  let schema: LoadedSchema | null;
  try {
    schema = loadBuiltInSchema(id);
  } catch (err: unknown) {
    errors.push({
      kind: "load_failed",
      pluginId: id,
      detail: err instanceof Error ? err.message : String(err),
    });
    continue;
  }

  if (schema === null) {
    errors.push({
      kind: "load_failed",
      pluginId: id,
      detail:
        "loadBuiltInSchema returned null (id not in BUILT_IN_PLUGIN_IDS at runtime?)",
    });
    continue;
  }

  // 1c. metadata.id must match.
  if (schema.metadata.id !== id) {
    errors.push({
      kind: "id_mismatch",
      pluginId: id,
      detail: `schema.yaml has metadata.id="${schema.metadata.id}" but expected "${id}"`,
    });
    continue;
  }

  // 1d. Must have auth section with at least one scheme.
  if (!schema.auth?.schemes?.length) {
    errors.push({
      kind: "invalid_shape",
      pluginId: id,
      detail:
        "schema is missing auth.schemes (must have at least one auth scheme)",
    });
    continue;
  }

  // 1e. Must have config.fields.
  if (!schema.config?.fields) {
    errors.push({
      kind: "invalid_shape",
      pluginId: id,
      detail: "schema is missing config.fields",
    });
    continue;
  }

  console.log(`  ✓ ${id}`);
}

// ── Check 2: no schema.yaml on disk is missing from BUILT_IN_PLUGIN_IDS ──────

console.log(
  "\ncheck-connector-schemas: scanning connectors/ for unregistered schema.yaml files…\n",
);

const connectorDirEntries = readdirSync(connectorsDir, { withFileTypes: true });
for (const entry of connectorDirEntries) {
  if (!entry.isDirectory()) continue;
  const dirName = entry.name;
  const schemaFile = resolve(connectorsDir, dirName, "schema.yaml");
  if (!existsSync(schemaFile)) continue;

  if (!BUILT_IN_PLUGIN_IDS.has(dirName)) {
    errors.push({
      kind: "unregistered_yaml",
      pluginId: dirName,
      detail: `connectors/${dirName}/schema.yaml exists but "${dirName}" is not in BUILT_IN_PLUGIN_IDS`,
    });
  }
}

// ── Check 3: all registered connectorIds appear in BUILT_IN_PLUGIN_IDS ───────

console.log(
  "check-connector-schemas: scanning connector source files for connectorId declarations…\n",
);

// Collect source files — scan all connector TypeScript source files.
const registeredIds = new Set<string>();
const sourceFiles = connectorDirEntries
  .flatMap((entry) => {
    if (entry.isDirectory()) {
      const subDir = resolve(connectorsDir, entry.name);
      try {
        return readdirSync(subDir)
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => resolve(subDir, f));
      } catch {
        return [] as string[];
      }
    }
    return [] as string[];
  })
  .concat(
    readdirSync(connectorsDir)
      .filter(
        (f) =>
          f.endsWith(".ts") &&
          !f.endsWith(".test.ts") &&
          f !== "index.ts" &&
          f !== "types.ts",
      )
      .map((f) => resolve(connectorsDir, f)),
  );

const CONNECTOR_ID_RE = /connectorId\s*:\s*["']([^"']+)["']/g;
for (const filePath of sourceFiles) {
  let src: string;
  try {
    src = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }
  CONNECTOR_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONNECTOR_ID_RE.exec(src)) !== null) {
    if (m[1]) registeredIds.add(m[1]);
  }
}

for (const connId of registeredIds) {
  if (!BUILT_IN_PLUGIN_IDS.has(connId)) {
    errors.push({
      kind: "connector_not_in_built_in",
      pluginId: connId,
      detail: `connectorId "${connId}" is registered in source but is not in BUILT_IN_PLUGIN_IDS and has no schema.yaml`,
    });
  } else {
    console.log(`  ✓ connector source registered: ${connId}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (errors.length === 0) {
  console.log(
    `\n✓ check-connector-schemas: all ${BUILT_IN_PLUGIN_IDS.size} built-in plugin schemas verified. No gaps.\n`,
  );
  process.exit(0);
} else {
  console.error(
    `\n✖ check-connector-schemas: ${errors.length} error(s) detected:\n`,
  );
  for (const e of errors) {
    console.error(
      `  [${e.kind}] ${e.pluginId}${e.detail ? ` — ${e.detail}` : ""}`,
    );
  }
  console.error(
    "\nFix all gaps above before merging. See OXA-1784 for context.\n",
  );
  process.exit(1);
}
