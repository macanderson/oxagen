// collectors/registry.ts: the collector modules this process can run, by type.
//
// A collector module is one file beside types.ts. modules.ts imports each one
// and hands it to registerCollectorModule, which finds the CollectorDefinition
// the file exports, whatever its export name.
//
// Module registrations run as import side effects, and a bundler can evaluate
// a module more than once. The registry lives on globalThis, as the connector
// registry does, and a second registration of a type keeps the first.
import type { CollectorDefinition, CollectorType } from "./types";

/** A collector module with its [scope] type erased, as the registry holds it. */
export type AnyCollectorDefinition = CollectorDefinition<unknown>;

const REGISTRY_KEY = Symbol.for("@oxagen/ingestion.collectorRegistry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<CollectorType, AnyCollectorDefinition>;
};

const globalRef = globalThis as GlobalWithRegistry;
const registry: Map<CollectorType, AnyCollectorDefinition> =
  globalRef[REGISTRY_KEY] ??
  (globalRef[REGISTRY_KEY] = new Map<CollectorType, AnyCollectorDefinition>());

/** Register one collector module. A second module for the same type is ignored. */
export function registerCollector<Config>(
  definition: CollectorDefinition<Config>,
): void {
  if (registry.has(definition.type)) return;
  registry.set(definition.type, definition as AnyCollectorDefinition);
}

const REQUIRED_METHODS = [
  "verify",
  "doorbell",
  "fetchById",
  "listChangedSince",
  "toWorkItem",
] as const;

/** True when the value has the shape of a CollectorDefinition. */
export function isCollectorDefinition(
  value: unknown,
): value is AnyCollectorDefinition {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== "string") return false;
  const config = candidate.config;
  if (config === null || typeof config !== "object") return false;
  if (typeof (config as { safeParse?: unknown }).safeParse !== "function")
    return false;
  return REQUIRED_METHODS.every(
    (name) => typeof candidate[name] === "function",
  );
}

/**
 * Register every CollectorDefinition a module file exports. Returns the types
 * it registered, so modules.ts fails loudly on a file that exports none.
 */
export function registerCollectorModule(
  moduleExports: Record<string, unknown>,
): CollectorType[] {
  const types: CollectorType[] = [];
  for (const value of Object.values(moduleExports)) {
    if (!isCollectorDefinition(value)) continue;
    registerCollector(value);
    types.push(value.type);
  }
  if (types.length === 0)
    throw new Error(
      "[collectors] the module exports no CollectorDefinition; export one with type, config, verify, doorbell, fetchById, listChangedSince, and toWorkItem",
    );
  return types;
}

/** The module for a collector type, or undefined when none is registered. */
export function getCollector(
  type: CollectorType,
): AnyCollectorDefinition | undefined {
  return registry.get(type);
}

/** Every registered collector type. */
export function listCollectorTypes(): CollectorType[] {
  return [...registry.keys()];
}

/** Remove one registration. Tests call this to keep one file from leaking into the next. */
export function unregisterCollector(type: CollectorType): void {
  registry.delete(type);
}
