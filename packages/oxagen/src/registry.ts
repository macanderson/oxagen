import type { CapabilityDeclaration } from "./types.js";

// Single source of truth: every capability appears here exactly once.
// API routes, MCP tools, and tests import declarations by name; the
// `tools/scripts/check_manifest.mjs` gate verifies every declared layer
// has a corresponding file on disk.

const registry = new Map<string, CapabilityDeclaration>();

export function registerCapability<C extends CapabilityDeclaration>(cap: C): C {
  if (registry.has(cap.name)) {
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
