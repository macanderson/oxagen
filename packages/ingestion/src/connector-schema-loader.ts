/**
 * Connector schema loader — built-in and partner plugins.
 *
 * Resolution order for `loadSchema(pluginId, options)`:
 *   1. Built-in: check BUILT_IN_PLUGIN_IDS set → read bundled YAML from disk.
 *   2. Partner:  if `options.schemaUrl` is provided → fetch YAML over HTTPS
 *                with retry and timeout, cache result in the
 *                `ingestion.connector_schemas` DB table, and return same
 *                LoadedConnectorSchema interface.
 *
 * `loadBuiltInSchema(pluginId)` is still exported for callers that only need
 * the built-in resolution path (e.g. handler bootstrap, unit tests).
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

// ── Partner fetch options ──────────────────────────────────────────────────────

/**
 * Options for loading a schema that may come from a partner URL rather than a
 * built-in bundled file.
 */
export interface LoadSchemaOptions {
  /**
   * HTTPS URL pointing to a partner-hosted `schema.yaml`.
   * Required when `pluginId` is not a known built-in connector.
   * Ignored (built-in takes precedence) when `pluginId` is a built-in.
   */
  schemaUrl?: string;

  /**
   * DB cache writer injected by the handler layer to persist fetched partner
   * schemas.  When omitted, caching is skipped (acceptable in tests / CLI).
   *
   * Receives the raw parsed schema and the source URL so the handler can write
   * to `ingestion.connector_schemas`.
   */
  cacheWriter?: (
    pluginId: string,
    schemaUrl: string,
    schema: LoadedConnectorSchema,
  ) => Promise<void>;

  /**
   * Maximum time in milliseconds to wait for a partner schema URL to respond.
   * Default: 10 000 (10 s).
   */
  fetchTimeoutMs?: number;

  /**
   * Number of retry attempts on network/server errors.
   * Default: 2 (total = 1 initial + 2 retries = 3 attempts).
   */
  maxRetries?: number;
}

// ── Cache ──────────────────────────────────────────────────────────────────────

/**
 * In-process schema cache to avoid re-reading files or re-fetching URLs on
 * repeated calls within the same process lifetime.
 *
 * Keys:
 *   built-in  → `pluginId`
 *   partner   → `pluginId` (after first successful fetch/cache)
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
 * Unified schema loader — built-in first, partner URL fallback.
 *
 * Resolution order:
 *   1. Built-in:  `pluginId` is in `BUILT_IN_PLUGIN_IDS` → read from disk,
 *                 ignore `options.schemaUrl` (built-in always wins).
 *   2. In-process cache: partner schema fetched earlier this process → return.
 *   3. Partner fetch: `options.schemaUrl` set → fetch YAML with retry+timeout,
 *                     validate basic shape, write DB cache, store in-process.
 *
 * Returns `null` when `pluginId` is neither a built-in nor has `schemaUrl`.
 * Throws on unrecoverable errors (malformed YAML, empty response, etc.).
 */
export async function loadSchema(
  pluginId: string,
  options?: LoadSchemaOptions,
): Promise<LoadedConnectorSchema | null> {
  // Built-in connectors always resolve from disk.
  const builtin = loadBuiltInSchema(pluginId);
  if (builtin !== null) {
    return builtin;
  }

  // In-process cache hit (previous partner fetch in this process).
  const cached = schemaCache.get(pluginId);
  if (cached !== undefined) {
    return cached;
  }

  // Partner URL fetch.
  const { schemaUrl, cacheWriter, fetchTimeoutMs = 10_000, maxRetries = 2 } =
    options ?? {};

  if (!schemaUrl) {
    return null;
  }

  const schema = await fetchPartnerSchema(schemaUrl, fetchTimeoutMs, maxRetries);

  // Warm in-process cache.
  schemaCache.set(pluginId, schema);

  // Persist to DB cache if a writer was injected.
  if (cacheWriter) {
    await cacheWriter(pluginId, schemaUrl, schema);
  }

  return schema;
}

// ── Partner schema fetcher ─────────────────────────────────────────────────────

/** How long to wait between retry attempts (milliseconds). */
const RETRY_DELAY_MS = 500;

/**
 * Fetch and parse a partner schema YAML from an HTTPS URL.
 *
 * Retries on 5xx and network errors up to `maxRetries` times with a fixed
 * delay.  Throws on 4xx (bad URL / permission), invalid YAML, or timeout.
 */
async function fetchPartnerSchema(
  schemaUrl: string,
  timeoutMs: number,
  maxRetries: number,
): Promise<LoadedConnectorSchema> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(schemaUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 400 && response.status < 500) {
        // 4xx is a permanent error — no point retrying.
        throw new Error(
          `connector-schema-loader: partner schema URL returned ${response.status} (${schemaUrl})`,
        );
      }

      if (!response.ok) {
        // 5xx or unexpected — retry.
        lastError = new Error(
          `connector-schema-loader: partner schema URL returned ${response.status} (${schemaUrl})`,
        );
        continue;
      }

      const text = await response.text();
      if (!text.trim()) {
        throw new Error(
          `connector-schema-loader: partner schema URL returned an empty response (${schemaUrl})`,
        );
      }

      const parsed = parseYaml(text) as unknown;
      return assertValidSchema(parsed, schemaUrl);
    } catch (err: unknown) {
      // AbortError = timeout.
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(
          `connector-schema-loader: partner schema URL timed out after ${timeoutMs}ms (${schemaUrl})`,
        );
        continue;
      }
      // Re-throw permanent (non-retryable) errors immediately.
      // These are always thrown by this module with a known prefix.
      if (
        err instanceof Error &&
        err.message.startsWith("connector-schema-loader:")
      ) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `connector-schema-loader: partner schema fetch failed for ${schemaUrl}`,
      );
}

/**
 * Assert that a parsed YAML value has the minimum required shape of a
 * ConnectorPlugin schema.  Throws with a descriptive message if not.
 */
function assertValidSchema(
  parsed: unknown,
  source: string,
): LoadedConnectorSchema {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `connector-schema-loader: schema from "${source}" did not parse to an object`,
    );
  }

  const raw = parsed as Record<string, unknown>;

  if (raw.apiVersion !== "oxagen.ai/v1alpha1") {
    throw new Error(
      `connector-schema-loader: schema from "${source}" has unsupported apiVersion: ${String(raw.apiVersion)}`,
    );
  }
  if (raw.kind !== "ConnectorPlugin") {
    throw new Error(
      `connector-schema-loader: schema from "${source}" has unexpected kind: ${String(raw.kind)}`,
    );
  }

  const meta = raw.metadata as Record<string, unknown> | undefined;
  if (!meta?.id || typeof meta.id !== "string") {
    throw new Error(
      `connector-schema-loader: schema from "${source}" is missing metadata.id`,
    );
  }

  return raw as LoadedConnectorSchema;
}

/** Promise-based delay helper. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────

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
