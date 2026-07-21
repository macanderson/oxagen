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
  globalRef[REGISTRY_KEY] ??
  (globalRef[REGISTRY_KEY] = new Map<string, CapabilityDeclaration>());

// A stable "signature" of a declaration's descriptor, used to tell a benign
// duplicate-module re-registration (the bundler evaluated one contract twice)
// apart from a genuine authoring collision (two *different* contracts claiming
// the same name). Zod schemas are not structurally comparable and serialize to
// `{}`, so they are reduced to an opaque marker; every other descriptor field
// participates in the comparison.
function capabilitySignature(cap: CapabilityDeclaration): string {
  return JSON.stringify(cap, (_key: string, value: unknown) => {
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
  if (cap.lifecycle) {
    const { allowedEvents, outputKinds } = cap.lifecycle;
    if (
      allowedEvents.length === 0 ||
      new Set(allowedEvents).size !== allowedEvents.length ||
      outputKinds.length === 0 ||
      new Set(outputKinds).size !== outputKinds.length
    ) {
      throw new Error(
        `invalid_lifecycle_metadata: capability "${cap.name}" must declare unique allowedEvents and outputKinds`,
      );
    }
  }
  const existing = registry.get(cap.name);
  if (existing) {
    // Same name, same shape → the bundler evaluated this contract module twice.
    // Hand back the first registration so both module instances share one
    // declaration object (keeps `getCapability(name) === <the export>` true).
    if (capabilitySignature(existing) === capabilitySignature(cap)) {
      return existing as C;
    }
    // Same name, different descriptor. In a clean module graph this would be a
    // genuine authoring collision — but bundlers (Turbopack dev + HMR) can
    // evaluate a contract module more than once in ways that desync the
    // descriptor across the RSC/SSR/edge graphs (distinct zod instances, reload
    // churn). Crashing the running app over that bundler artifact is worse than
    // the collision we guard against, and it took down every dev-server page
    // (and all e2e). Genuine duplicate *names* are caught deterministically at
    // build time by tools/scripts/check_manifest.mjs (it fails on two contract
    // files claiming one name). So warn (dev-visible) and keep the first
    // registration instead of throwing.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[oxagen] Capability "${cap.name}" re-registered with a different descriptor; ` +
          `keeping the first registration (likely a dev bundler/HMR artifact). ` +
          `A real duplicate-name collision is failed by \`pnpm check:manifest\`.`,
      );
    }
    return existing as C;
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
