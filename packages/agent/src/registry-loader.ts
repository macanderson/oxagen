/**
 * Shared lazy loader for the @oxagen/oxagen capability registry.
 *
 * A dynamic import is required to avoid a static package cycle:
 * @oxagen/oxagen handlers depend on @oxagen/agent; if either imported the
 * other at the top-level the build would deadlock. We load the module once
 * and cache its entry-point functions.
 *
 * This module is the single source of truth for the load path and the
 * shared type, so materialize-tools.ts and agent.tool.list.ts don't each
 * keep their own diverging inline type shape.
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
  /**
   * Whether the capability writes. Mirrored from the contract so
   * `capabilityMutates` can be applied to this structural view; absent means
   * it mutates, which is what makes an unmirrored or undeclared capability
   * serialize rather than silently run concurrently.
   */
  mutates?: boolean;
  /**
   * The contract's IAM default effect. Optional here (decoupled structural
   * view); when absent, readers MUST fall back to "deny" — the SAME fallback
   * the kernel applies (packages/oxagen/src/kernel.ts's IAM seam), so the
   * agent-run tool filter and the kernel gate can never disagree about a
   * capability's default (Agent RBAC spec §3.5: one resolution, two readers).
   */
  defaultEffect?: "allow" | "deny" | "require_approval";
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
 * { listCapabilities, getSurfaces, getCapability } triple. Safe to call from
 * multiple modules — only one dynamic import fires per process, even with
 * concurrent calls.
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
