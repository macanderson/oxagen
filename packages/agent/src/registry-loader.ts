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
  /** Zod schema or equivalent — typed as unknown to avoid coupling. */
  input?: unknown;
  surfaces?: readonly ("api" | "mcp" | "agent")[];
}

export interface OxagenRegistry {
  listCapabilities: () => RegistryCapability[];
  getSurfaces: (c: RegistryCapability) => readonly string[];
}

let _registry: OxagenRegistry | null = null;

/**
 * Lazily loads and caches the @oxagen/oxagen module, returning the typed
 * { listCapabilities, getSurfaces } pair. Safe to call from multiple
 * modules — only one dynamic import fires per process.
 */
export async function getOxagenRegistry(): Promise<OxagenRegistry> {
  if (_registry) return _registry;
  const mod = (await import("@oxagen/oxagen")) as unknown as OxagenRegistry;
  _registry = { listCapabilities: mod.listCapabilities, getSurfaces: mod.getSurfaces };
  return _registry;
}
