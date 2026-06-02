// Catalog is DERIVED from @oxagen/config ENV_REGISTRY — do not edit by hand.
// To add or modify an env var, edit packages/config/src/registry.ts instead.
import { ENV_NAMES, ENV_REGISTRY, staticValueFor } from "@oxagen/config";
import type { CatalogEntry, Source } from "./types";
import type { EnvName } from "@oxagen/config";

function buildSources(
  key: string,
  valueOrigin: "static" | "generate" | "manual",
): Partial<Record<EnvName, Source>> {
  const sources: Partial<Record<EnvName, Source>> = {};
  for (const env of ENV_NAMES) {
    if (valueOrigin === "static") {
      const value = staticValueFor(key, env);
      if (value !== undefined) sources[env] = { type: "static", value };
    } else if (valueOrigin === "generate") {
      sources[env] = { type: "generate", bytes: 32 };
    } else {
      sources[env] = { type: "manual" };
    }
  }
  return sources;
}

export const CATALOG: CatalogEntry[] = Object.entries(ENV_REGISTRY)
  .filter(([, meta]) => meta.services.length > 0)
  .map(([key, meta]) => ({
    key,
    group: meta.group,
    description: meta.description,
    secret: meta.secret,
    services: meta.services,
    sources: buildSources(key, meta.valueOrigin),
  }));
