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
// Alias → canonical-name index (ADR-022). Anchored on globalThis for the same
// bundler/HMR duplicate-module reasons as the registry itself.
const ALIAS_KEY = Symbol.for("@oxagen/oxagen.capabilityAliasIndex");
// Aliases already warned about, so a deprecated call logs at most once per
// process instead of spamming every invocation.
const ALIAS_WARNED_KEY = Symbol.for("@oxagen/oxagen.capabilityAliasWarned");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, CapabilityDeclaration>;
  [ALIAS_KEY]?: Map<string, string>;
  [ALIAS_WARNED_KEY]?: Set<string>;
};

const globalRef = globalThis as GlobalWithRegistry;
const registry: Map<string, CapabilityDeclaration> =
  globalRef[REGISTRY_KEY] ??
  (globalRef[REGISTRY_KEY] = new Map<string, CapabilityDeclaration>());
const aliasIndex: Map<string, string> =
  globalRef[ALIAS_KEY] ?? (globalRef[ALIAS_KEY] = new Map<string, string>());
const aliasWarned: Set<string> =
  globalRef[ALIAS_WARNED_KEY] ??
  (globalRef[ALIAS_WARNED_KEY] = new Set<string>());

// Injected deprecation sink (ADR-022). Surfaces wire this at bootstrap to emit
// a telemetry counter when a legacy alias is resolved; kept behind a setter so
// the dependency-light registry never imports @oxagen/telemetry. When unset,
// the first hit per alias falls back to a single console.warn.
type AliasDeprecationSink = (alias: string, canonical: string) => void;
let _aliasDeprecationSink: AliasDeprecationSink | null = null;

export function setAliasDeprecationSink(sink: AliasDeprecationSink | null): void {
  _aliasDeprecationSink = sink;
}

function reportAliasHit(alias: string, canonical: string): void {
  if (aliasWarned.has(alias)) return;
  aliasWarned.add(alias);
  if (_aliasDeprecationSink) {
    try {
      _aliasDeprecationSink(alias, canonical);
    } catch {
      // A broken sink must never break capability resolution.
    }
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[oxagen] Capability "${alias}" is a deprecated alias for "${canonical}" (ADR-022). ` +
        `Update the caller to the canonical name.`,
    );
  }
}

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
  // Index every retired alias to this canonical name (ADR-022). A collision
  // with a real capability name is an authoring bug — never let an alias
  // shadow a live capability; the canonical registry entry always wins.
  for (const alias of cap.aliases ?? []) {
    if (registry.has(alias)) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[oxagen] Alias "${alias}" of "${cap.name}" collides with a live capability name; ignoring the alias.`,
        );
      }
      continue;
    }
    aliasIndex.set(alias, cap.name);
  }
  return cap;
}

/**
 * Resolve a name to its canonical form (ADR-022): returns the name unchanged if
 * it is a live capability name, else the canonical name it aliases, else the
 * input untouched (unknown names pass through so callers still hit the usual
 * "unknown capability" path). Pure — never warns.
 */
export function resolveCanonicalName(name: string): string {
  if (registry.has(name)) return name;
  return aliasIndex.get(name) ?? name;
}

/**
 * Every name a capability answers to — its canonical name plus all retired
 * aliases. Used by the IAM layer to match legacy `role_grants`/`grants`/
 * `policies` rows keyed by an old name (ADR-022). Accepts a canonical OR alias
 * name. Returns `[name]` for an unknown name.
 */
export function namesForCapability(name: string): string[] {
  const canonical = resolveCanonicalName(name);
  const cap = registry.get(canonical);
  if (!cap) return [name];
  return [canonical, ...(cap.aliases ?? [])];
}

export function getCapability(name: string): CapabilityDeclaration | undefined {
  const direct = registry.get(name);
  if (direct) return direct;
  const canonical = aliasIndex.get(name);
  if (canonical) {
    reportAliasHit(name, canonical);
    return registry.get(canonical);
  }
  return undefined;
}

export function listCapabilities(): CapabilityDeclaration[] {
  return Array.from(registry.values());
}

export function clearRegistryForTests(): void {
  registry.clear();
  aliasIndex.clear();
  aliasWarned.clear();
}
