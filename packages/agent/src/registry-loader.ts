/**
 * Shared lazy loader for the @oxagen/oxagen capability registry.
 *
 * A dynamic import is required to avoid a static package cycle:
 * @oxagen/oxagen handlers depend on @oxagen/agent; if either imported the
 * other at the top-level the build would deadlock. We load the module once
 * and cache the two entry-point functions.
 *
 * Both materialize-tools.ts and agent.tool.list.ts previously duplicated this
 * pattern with divergent inline type shapes. This module is the single source
 * of truth for the load path and the shared type.
 */

export interface RegistryCapability {
  name: string;
  description: string;
  /** Present on capabilities registered with a domain field. */
  domain?: string;
  agent?: {
    riskLevel?: "low" | "medium" | "high";
    category?: string;
    requiresApproval?: boolean;
  };
  /**
   * Required on the underlying CapabilityDeclaration; optional here because
   * this is a decoupled structural view. Read by the dispatch guard's
   * mutating classification (materialize-tools isMutatingCapability).
   */
  sensitivity?: "low" | "medium" | "high" | "destructive";
  /** Zod schema or equivalent — typed as unknown to avoid coupling. */
  input?: unknown;
  surfaces?: readonly ("api" | "mcp" | "agent")[];
}

export interface OxagenRegistry {
  listCapabilities: () => RegistryCapability[];
  getSurfaces: (c: RegistryCapability) => readonly string[];
  /** Look up a single capability by name, or undefined when not registered. */
  getCapability: (name: string) => RegistryCapability | undefined;
}

let _registryPromise: Promise<OxagenRegistry> | null = null;

/**
 * Lazily loads and caches the @oxagen/oxagen module, returning the typed
 * { listCapabilities, getSurfaces } pair. Safe to call from multiple
 * modules — only one dynamic import fires per process, even with concurrent calls.
 */
export async function getOxagenRegistry(): Promise<OxagenRegistry> {
  if (_registryPromise) return _registryPromise;
  _registryPromise = (async () => {
    const mod = (await import("@oxagen/oxagen")) as unknown as OxagenRegistry;
    return {
      listCapabilities: mod.listCapabilities,
      getSurfaces: mod.getSurfaces,
      getCapability: mod.getCapability,
    };
  })();
  return _registryPromise;
}
