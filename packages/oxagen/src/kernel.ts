import type { CapabilityContext, CapabilitySurface } from "./types.js";
import { getSurfaces } from "./types.js";
import { getCapability, listCapabilities } from "./registry.js";

// The capability kernel: the single dispatch path every surface (api, mcp,
// cli, in-app agent) calls. It binds a registered *contract* to its
// registered *handler*, validates input and output against the contract's
// Zod schemas, and enforces the contract's surface allowlist.
//
// Contracts register in `registry.ts` (pure, dependency-light). Handlers
// register here as lazy loaders from their own packages (`@oxagen/handlers`,
// `@oxagen/agent`) so the kernel never statically imports handler code and
// stays free of heavy dependency chains (Docker, Neo4j, Stripe) until a
// capability is actually invoked.

export type CapabilityHandlerFn = (
  input: unknown,
  ctx: CapabilityContext,
) => Promise<unknown>;

export type HandlerLoader = () => Promise<CapabilityHandlerFn>;

const loaders = new Map<string, HandlerLoader>();
const cache = new Map<string, CapabilityHandlerFn>();

export type CapabilityErrorCode =
  | "unknown_capability"
  | "no_handler"
  | "surface_denied"
  | "invalid_input"
  | "invalid_output";

export class CapabilityError extends Error {
  constructor(
    readonly capability: string,
    readonly code: CapabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

/**
 * Bind a handler to a capability name. Throws on a double-registration so a
 * copy-paste that shadows an existing handler fails loudly at boot rather
 * than silently winning the map.
 */
export function registerHandler(name: string, loader: HandlerLoader): void {
  if (loaders.has(name)) {
    throw new Error(`Handler for "${name}" already registered`);
  }
  loaders.set(name, loader);
}

export function hasHandler(name: string): boolean {
  return loaders.has(name);
}

async function resolveHandler(name: string): Promise<CapabilityHandlerFn> {
  const cached = cache.get(name);
  if (cached) return cached;
  const loader = loaders.get(name);
  if (!loader) {
    throw new CapabilityError(
      name,
      "no_handler",
      `No handler registered for capability "${name}". Did its package's register module run?`,
    );
  }
  const fn = await loader();
  cache.set(name, fn);
  return fn;
}

export interface InvokeOptions {
  /**
   * Surface the call arrives on. When set, the kernel enforces the
   * contract's `surfaces` allowlist — e.g. an `agent`-only capability
   * invoked over `mcp` is rejected before the handler runs.
   */
  surface?: CapabilitySurface;
}

/**
 * The one dispatch path. Resolves the contract, validates input against the
 * contract schema, runs the bound handler, and validates the output so a
 * drifting handler can never return a shape that violates the contract.
 */
export async function invoke(
  name: string,
  rawInput: unknown,
  ctx: CapabilityContext,
  opts: InvokeOptions = {},
): Promise<unknown> {
  const cap = getCapability(name);
  if (!cap) {
    throw new CapabilityError(name, "unknown_capability", `Unknown capability "${name}"`);
  }

  if (opts.surface && !getSurfaces(cap).includes(opts.surface)) {
    throw new CapabilityError(
      name,
      "surface_denied",
      `Capability "${name}" is not exposed on the "${opts.surface}" surface`,
    );
  }

  const inputResult = cap.input.safeParse(rawInput);
  if (!inputResult.success) {
    throw new CapabilityError(
      name,
      "invalid_input",
      `Input validation failed for "${name}": ${inputResult.error.message}`,
    );
  }

  const handler = await resolveHandler(name);
  const output = await handler(inputResult.data, ctx);

  const outputResult = cap.output.safeParse(output);
  if (!outputResult.success) {
    throw new CapabilityError(
      name,
      "invalid_output",
      `Output validation failed for "${name}": ${outputResult.error.message}`,
    );
  }
  return outputResult.data;
}

/**
 * Drift guard for the verification gate: every capability exposed on a
 * machine surface must have a bound handler. Run after all register modules
 * have imported. Throws listing the gaps so CI fails with an actionable
 * message instead of a 500 at request time.
 */
export function assertHandlersComplete(
  opts: { surfaces?: readonly CapabilitySurface[] } = {},
): void {
  const required = opts.surfaces ?? (["api", "mcp", "agent"] as const);
  const missing: string[] = [];
  for (const cap of listCapabilities()) {
    const surfaces = getSurfaces(cap);
    if (required.some((s) => surfaces.includes(s)) && !loaders.has(cap.name)) {
      missing.push(cap.name);
    }
  }
  if (missing.length) {
    throw new Error(
      `Capabilities missing a registered handler:\n  - ${missing.join("\n  - ")}`,
    );
  }
}

/** Capabilities a given surface can dispatch. Surfaces iterate this to build
 * their transport bindings (mcp tool list, cli command tree, api routes). */
export function capabilitiesForSurface(
  surface: CapabilitySurface,
): ReturnType<typeof listCapabilities> {
  return listCapabilities().filter((cap) => getSurfaces(cap).includes(surface));
}

/** Test-only reset of the handler registry. Mirrors clearRegistryForTests. */
export function clearHandlersForTests(): void {
  loaders.clear();
  cache.clear();
}
