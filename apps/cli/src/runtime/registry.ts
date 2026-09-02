/**
 * The model registry — the single, data-driven source of truth for which models
 * the CLI knows about, loaded from `models.json`.
 *
 * The capability table is *data*: editing a row in `models.json` changes the
 * default on-device model with no code change, which is the whole point — the
 * open-source model landscape moves fast (requirement 3). Everything here is a
 * thin, typed accessor over that file. Cloud gateway slugs stay overridable via
 * env so the CLI tracks gateway slug drift without a re-release.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import registryJson from "./models.json" with { type: "json" };
import type {
  CapabilityRow,
  CloudModelEntry,
  RegistryFile,
  RuntimeConfigDefaults,
} from "./types.js";

const REGISTRY = registryJson as unknown as RegistryFile;

/** The parsed, typed registry file. */
export function loadRegistry(): RegistryFile {
  return REGISTRY;
}

/** Baked-in runtime config defaults (before user config / env overrides). */
export function registryDefaults(): RuntimeConfigDefaults {
  return REGISTRY.config.runtime;
}

/** The on-device capability table, sorted by codeScore descending. */
export function capabilityTable(): CapabilityRow[] {
  return [...REGISTRY.capabilityTable.rows].sort(
    (a, b) => b.codeScore - a.codeScore,
  );
}

/** Look up one capability row by its modelId. */
export function capabilityRow(modelId: string): CapabilityRow | undefined {
  return REGISTRY.capabilityTable.rows.find((r) => r.modelId === modelId);
}

/**
 * Resolve a cloud model entry by its friendly registry id (e.g. "haiku",
 * "sonnet-5"). The concrete gateway slug is overridable per-env so the CLI
 * tracks Vercel AI Gateway slug drift without a code change — mirroring the
 * pattern in `agent/model-router.ts`.
 */
export function cloudModel(id: string): CloudModelEntry | undefined {
  const entry = REGISTRY.cloudModels[id];
  if (!entry) return undefined;
  const envKey = `OXAGEN_MODEL_${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`;
  const override = process.env[envKey];
  return override ? { ...entry, slug: override } : entry;
}

/** Every known cloud model id. */
export function cloudModelIds(): string[] {
  return Object.keys(REGISTRY.cloudModels);
}

/** The registry's role assignments (coordinator candidates, workers, judge). */
export function roles(): RegistryFile["registry"] {
  return REGISTRY.registry;
}

/**
 * Expand a `~`-prefixed path (as used by `onDevice.cacheDir` in models.json) to
 * an absolute path under the user's home directory.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
