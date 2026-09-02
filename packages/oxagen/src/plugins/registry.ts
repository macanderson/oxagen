import {
  oxagenPluginManifestSchema,
  type OxagenPluginManifest,
} from "./manifest";
import { mediaVideoManifest } from "./catalog/media-video/manifest";
import { mediaImageManifest } from "./catalog/media-image/manifest";
import { mediaSvgManifest } from "./catalog/media-svg/manifest";
import { documentsManifest } from "./catalog/documents/manifest";
import { sweBenchEvalsManifest } from "./catalog/swe-bench-evals/manifest";
import { listCapabilities } from "../registry";

// ── Plugin registry — bundler double-eval safety ─────────────────────────────
//
// Anchored on globalThis via Symbol.for (mirrors src/registry.ts:18) so that
// under Turbopack HMR / RSC-vs-SSR dual module graphs the same Map instance is
// always returned regardless of which specifier resolved this module.

const PLUGIN_REGISTRY_KEY = Symbol.for("@oxagen/oxagen.pluginRegistry");

type GlobalWithPluginRegistry = typeof globalThis & {
  [PLUGIN_REGISTRY_KEY]?: {
    byId: Map<string, OxagenPluginManifest>;
    /** O(1) contract → plugin lookup index. */
    contractIndex: Map<string, OxagenPluginManifest>;
  };
};

const globalRef = globalThis as GlobalWithPluginRegistry;

// ── Build the registry on first access ───────────────────────────────────────

function buildRegistry(): {
  byId: Map<string, OxagenPluginManifest>;
  contractIndex: Map<string, OxagenPluginManifest>;
} {
  const byId = new Map<string, OxagenPluginManifest>();
  const contractIndex = new Map<string, OxagenPluginManifest>();

  const allManifests: OxagenPluginManifest[] = [
    mediaVideoManifest,
    mediaImageManifest,
    mediaSvgManifest,
    documentsManifest,
    sweBenchEvalsManifest,
  ];

  for (const raw of allManifests) {
    // Validate each manifest against the zod schema at registration time.
    const parsed = oxagenPluginManifestSchema.parse(raw);

    if (byId.has(parsed.id)) {
      throw new Error(
        `Duplicate plugin id "${parsed.id}" — each plugin must have a unique id.`,
      );
    }

    for (const contractName of parsed.contracts) {
      const existing = contractIndex.get(contractName);
      if (existing) {
        throw new Error(
          `Contract "${contractName}" is claimed by both "${existing.id}" and "${parsed.id}". ` +
            "A contract may be claimed by at most one plugin.",
        );
      }
      contractIndex.set(contractName, parsed);
    }

    byId.set(parsed.id, parsed);
  }

  return { byId, contractIndex };
}

function getStore(): {
  byId: Map<string, OxagenPluginManifest>;
  contractIndex: Map<string, OxagenPluginManifest>;
} {
  if (!globalRef[PLUGIN_REGISTRY_KEY]) {
    globalRef[PLUGIN_REGISTRY_KEY] = buildRegistry();
  }
  return globalRef[PLUGIN_REGISTRY_KEY];
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return all registered plugin manifests, in insertion order. */
export function listOxagenPlugins(): OxagenPluginManifest[] {
  return Array.from(getStore().byId.values());
}

/** Look up a plugin by its stable id (e.g. "oxagen/media-video"). */
export function getOxagenPlugin(id: string): OxagenPluginManifest | undefined {
  return getStore().byId.get(id);
}

/**
 * O(1) lookup: which plugin (if any) claims the given capability contract name?
 * Returns undefined when the contract is builtin (not claimed by any plugin).
 */
export function pluginForContract(
  capabilityName: string,
): OxagenPluginManifest | undefined {
  return getStore().contractIndex.get(capabilityName);
}

// ── Cross-check helper (call from tests, not at module load) ──────────────────
//
// Validates that every contract name claimed by a registered plugin actually
// exists in the live capability registry. This MUST NOT run at module load:
// contract registration order is indeterminate across bundler evaluations.
// Export it and call it from `registry.test.ts` after importing the contracts barrel.

/**
 * Cross-check the plugin contract index against the live capability registry.
 * Throws listing any contract names that no registered capability declares.
 *
 * Call this from a test — not at module load — since capability registration
 * order is non-deterministic across bundler evaluations (import side-effects).
 */
export function validateOxagenPluginContracts(): void {
  const store = getStore();
  const registeredNames = new Set(listCapabilities().map((c) => c.name));
  const unknownContracts: string[] = [];

  for (const contractName of store.contractIndex.keys()) {
    if (!registeredNames.has(contractName)) {
      unknownContracts.push(contractName);
    }
  }

  if (unknownContracts.length > 0) {
    throw new Error(
      `Plugin registry claims contracts that do not exist in the capability registry:\n` +
        unknownContracts.map((n) => `  - ${n}`).join("\n") +
        "\nEnsure all contracts are registered before calling validateOxagenPluginContracts().",
    );
  }
}

/** Test-only reset — clears the globalThis anchor so the registry rebuilds. */
export function clearPluginRegistryForTests(): void {
  delete (globalRef as Partial<typeof globalRef>)[PLUGIN_REGISTRY_KEY];
}
