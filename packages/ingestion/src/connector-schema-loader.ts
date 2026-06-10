/**
 * Built-in connector schema loader.
 *
 * Loads and parses YAML schema files bundled alongside each built-in connector.
 * Used by plugin.schema.get to seed the DB cache on first access.
 *
 * Partner plugin URL fetch is NOT implemented here — that is a later enhancement.
 *
 * NOTE: This module does not import from @oxagen/oxagen to avoid a circular
 * dependency (ingestion → oxagen). The ConnectorPluginSchema type is declared
 * locally as a minimal structural type. The handler layer, which already
 * depends on @oxagen/oxagen, casts the loaded value to the canonical type.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ESM-compatible __dirname.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Local structural type ──────────────────────────────────────────────────────
// Mirrors the shape produced by parsing a connector plugin YAML schema.
// Kept minimal — only the fields the loader and validator actually read.

interface FieldValidation {
  required?: boolean;
  min?: number;
  max?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  itemPattern?: string;
  oneOf?: string[];
}

interface SchemaField {
  key: string;
  label: string;
  validation?: FieldValidation;
}

interface AuthScheme {
  id: string;
  kind: string;
  fields?: SchemaField[];
}

/** Minimal structural representation of a parsed connector plugin YAML schema. */
export interface LoadedConnectorSchema {
  apiVersion: string;
  kind: string;
  metadata: {
    id: string;
    displayName: string;
    version: string;
    schemaVersion: string;
    description?: string;
    icon?: string;
    category?: string;
    publisher: { name: string; verified: boolean };
  };
  auth?: { schemes: AuthScheme[] };
  config?: { fields: SchemaField[] };
  [key: string]: unknown;
}

// ── Cache ──────────────────────────────────────────────────────────────────────

/**
 * In-process schema cache to avoid re-reading files on repeated calls.
 * Keyed by pluginId.
 */
const schemaCache = new Map<string, LoadedConnectorSchema>();

// ── Built-in connector IDs ─────────────────────────────────────────────────────

/**
 * Connector IDs that ship with bundled YAML schema files.
 * Folder name under packages/ingestion/src/connectors/ must match the id.
 */
const BUILT_IN_PLUGIN_IDS = new Set([
  "github",
  "google-drive",
  "linear",
  "slack",
]);

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Load a built-in connector's schema from the bundled YAML file.
 *
 * Returns null when pluginId is not a known built-in (e.g. partner plugins),
 * so the caller can attempt an alternative resolution path.
 *
 * Throws when the YAML file exists but fails to parse or produces an
 * unexpected shape — this is a deployment error and should surface loudly.
 */
export function loadBuiltInSchema(pluginId: string): LoadedConnectorSchema | null {
  if (!BUILT_IN_PLUGIN_IDS.has(pluginId)) {
    return null;
  }

  const hit = schemaCache.get(pluginId);
  if (hit) {
    return hit;
  }

  const schemaPath = resolve(__dirname, "connectors", pluginId, "schema.yaml");
  const content = readFileSync(schemaPath, "utf-8");
  const parsed = parseYaml(content) as unknown;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`connector-schema-loader: YAML for "${pluginId}" did not parse to an object`);
  }

  const loaded = parsed as LoadedConnectorSchema;
  schemaCache.set(pluginId, loaded);
  return loaded;
}

/**
 * Field-level validation error shape returned by validateConfigAgainstSchema.
 */
export interface ConfigValidationError {
  field: string;
  message: string;
  code:
    | "required"
    | "min"
    | "max"
    | "minItems"
    | "maxItems"
    | "pattern"
    | "itemPattern"
    | "oneOf"
    | "type"
    | "unknown";
}

/**
 * Validate a config object against a LoadedConnectorSchema.
 *
 * Checks:
 * - required fields are present (top-level config fields + auth scheme fields)
 * - string fields match their pattern constraint
 * - array fields satisfy minItems / maxItems
 * - array items satisfy itemPattern
 * - number fields satisfy min / max
 * - enum fields satisfy oneOf
 *
 * @param config       The raw config values submitted by the user.
 * @param pluginSchema The full connector plugin schema.
 * @param authSchemeId Optional auth scheme id to validate auth fields too.
 * @returns            Array of field-level errors (empty = valid).
 */
export function validateConfigAgainstSchema(
  config: Record<string, unknown>,
  pluginSchema: LoadedConnectorSchema,
  authSchemeId?: string,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // Validate top-level config fields.
  const configFields = pluginSchema.config?.fields ?? [];
  for (const field of configFields) {
    validateField(`config.${field.key}`, config[field.key], field.validation, errors);
  }

  // Validate auth scheme fields when authSchemeId is provided.
  if (authSchemeId) {
    const scheme = pluginSchema.auth?.schemes.find((s) => s.id === authSchemeId);
    if (scheme?.fields) {
      for (const field of scheme.fields) {
        validateField(`auth.${field.key}`, config[field.key], field.validation, errors);
      }
    }
  }

  return errors;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function validateField(
  path: string,
  value: unknown,
  validation: FieldValidation | undefined,
  errors: ConfigValidationError[],
): void {
  if (!validation) return;

  const absent = value === undefined || value === null || value === "";

  if (validation.required === true && absent) {
    errors.push({ field: path, message: `${path} is required`, code: "required" });
    // No further checks if the value is absent.
    return;
  }

  if (absent) {
    // Field is optional and not present — nothing more to check.
    return;
  }

  // String / pattern check.
  if (validation.pattern !== undefined && typeof value === "string") {
    const regex = new RegExp(validation.pattern);
    if (!regex.test(value)) {
      errors.push({
        field: path,
        message: `${path} does not match required format`,
        code: "pattern",
      });
    }
  }

  // oneOf check.
  if (validation.oneOf !== undefined && typeof value === "string") {
    if (!validation.oneOf.includes(value)) {
      errors.push({
        field: path,
        message: `${path} must be one of: ${validation.oneOf.join(", ")}`,
        code: "oneOf",
      });
    }
  }

  // Number range checks.
  if (typeof value === "number") {
    if (validation.min !== undefined && value < validation.min) {
      errors.push({
        field: path,
        message: `${path} must be at least ${validation.min}`,
        code: "min",
      });
    }
    if (validation.max !== undefined && value > validation.max) {
      errors.push({
        field: path,
        message: `${path} must be at most ${validation.max}`,
        code: "max",
      });
    }
  }

  // Array checks.
  if (Array.isArray(value)) {
    if (validation.minItems !== undefined && value.length < validation.minItems) {
      errors.push({
        field: path,
        message: `${path} must have at least ${validation.minItems} item(s)`,
        code: "minItems",
      });
    }
    if (validation.maxItems !== undefined && value.length > validation.maxItems) {
      errors.push({
        field: path,
        message: `${path} must have at most ${validation.maxItems} item(s)`,
        code: "maxItems",
      });
    }
    if (validation.itemPattern !== undefined) {
      const regex = new RegExp(validation.itemPattern);
      for (const item of value) {
        if (typeof item === "string" && !regex.test(item)) {
          errors.push({
            field: path,
            message: `${path} contains an item that does not match required format: ${item}`,
            code: "itemPattern",
          });
          // Report first failing item only to keep errors actionable.
          break;
        }
      }
    }
  }
}

/** Test-only: clear the in-process schema cache. */
export function _clearSchemaCacheForTest(): void {
  schemaCache.clear();
}
