import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Runtime data assets that esbuild cannot inline into the API bundle and that
 * build.mjs must copy next to the function.
 *
 * The built-in connector schema YAMLs are read at runtime by @oxagen/ingestion's
 * `loadBuiltInSchema` via `readFileSync` (driving the connector install /
 * "Configure" forms). esbuild inlines JS/TS but not data files, so without this
 * copy the bundled serverless function 500s on every plugin.schema.get call.
 *
 * Returns `{ src, dest }` pairs where `dest` is RELATIVE to the function
 * directory, preserving the `connectors/<id>/` layout that the loader's
 * `moduleDir()`-relative resolution expects.
 *
 * @param {string} baseUrl - resolution anchor; defaults to this module's URL
 *   (apps/api/). Overridable for tests.
 */
export function connectorSchemaAssets(baseUrl = import.meta.url) {
  const connectorsSrc = fileURLToPath(
    new URL("../../packages/ingestion/src/connectors", baseUrl),
  );

  const assets = [];
  for (const entry of readdirSync(connectorsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = `${connectorsSrc}/${entry.name}/schema.yaml`;
    if (!existsSync(src)) continue;
    assets.push({ src, dest: `connectors/${entry.name}/schema.yaml` });
  }
  return assets;
}
