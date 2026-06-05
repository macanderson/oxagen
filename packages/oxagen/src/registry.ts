import type { CapabilityDeclaration } from "./types";

// Single source of truth: every capability appears here exactly once.
// API routes, MCP tools, and tests import declarations by name; the
// `tools/scripts/check_manifest.mjs` gate verifies every declared layer
// has a corresponding file on disk.
//
// The registry must be a true *process* singleton. A bundler (Turbopack /
// webpack) can evaluate the same contract module more than once: a contract is
// reachable both through the package's "." barrel (which imports it via a
// relative `./contracts/<name>` specifier) and through its `./contracts/*`
// subpath export (which app code imports as `@oxagen/oxagen/contracts/<name>`).
// Those two specifiers can resolve to two distinct module instances, so the
// top-level `registerCapability()` side-effect runs twice. The same happens
// across the RSC/SSR module graphs and on HMR reloads in dev. Anchor the map on
// `globalThis` so every instance shares one source of truth instead of each
// holding a partial copy.
const REGISTRY_KEY = Symbol.for("@oxagen/oxagen.capabilityRegistry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, CapabilityDeclaration>;
};

const globalRef = globalThis as GlobalWithRegistry;
const registry: Map<string, CapabilityDeclaration> =
  globalRef[REGISTRY_KEY] ?? (globalRef[REGISTRY_KEY] = new Map());

// A stable "signature" of a declaration's descriptor, used to tell a benign
// duplicate-module re-registration (the bundler evaluated one contract twice)
// apart from a genuine authoring collision (two *different* contracts claiming
// the same name). Zod schemas are not structurally comparable and serialize to
// `{}`, so they are reduced to an opaque marker; every other descriptor field
// participates in the comparison.
function capabilitySignature(cap: CapabilityDeclaration): string {
  return JSON.stringify(cap, (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { safeParse?: unknown }).safeParse === "function"
    ) {
      return "<zod-schema>";
    }
    return value;
  });
}

export function registerCapability<C extends CapabilityDeclaration>(cap: C): C {
  const existing = registry.get(cap.name);
  if (existing) {
    // Same name, same shape → the bundler evaluated this contract module twice.
    // Hand back the first registration so both module instances share one
    // declaration object (keeps `getCapability(name) === <the export>` true).
    if (capabilitySignature(existing) === capabilitySignature(cap)) {
      return existing as C;
    }
    // Same name, different shape → a real collision: two contracts are fighting
    // over one capability name. Fail loudly so the authoring mistake surfaces.
    throw new Error(`Capability "${cap.name}" already registered`);
  }
  registry.set(cap.name, cap as CapabilityDeclaration);
  return cap;
}

export function getCapability(name: string): CapabilityDeclaration | undefined {
  return registry.get(name);
}

export function listCapabilities(): CapabilityDeclaration[] {
  return Array.from(registry.values());
}

export function clearRegistryForTests(): void {
  registry.clear();
}
