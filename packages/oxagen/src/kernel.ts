import type { CapabilityContext, CapabilitySurface, CapabilityEffect, ResolvedPrincipal } from "./types.js";
import { getSurfaces } from "./types.js";
import { getCapability, listCapabilities } from "./registry.js";

// ── IAM runtime injection (mirrors define-contract.ts pattern) ────────────────
//
// The kernel accepts the same IAMCheckFn / audit-emitter injection as
// defineContract so the single kernel.invoke() dispatch path can run the
// full IAM resolution + ClickHouse audit write on EVERY capability call,
// including those that bypass defineContract().
//
// ENFORCEMENT FLAG: the kernel always resolves authz and always emits the
// audit event (SOC2 audit coverage from day 1). It only BLOCKS the call when
// IAM_ENFORCEMENT_ENABLED=true, so the flag can be off during the initial
// seeding period with zero lockout risk.

export interface KernelIAMCheckResult {
  outcome: "allow" | "deny" | "pending_approval";
  reason?: string;
  principal: ResolvedPrincipal | null;
}

export type KernelIAMCheckFn = (args: {
  capability: string;
  ctx: CapabilityContext;
  defaultEffect: CapabilityEffect;
  rawInputJson: string;
}) => Promise<KernelIAMCheckResult>;

export type KernelAuditEmitFn = (args: {
  capability: string;
  ctx: CapabilityContext;
  outcome: "allow" | "deny" | "pending_approval";
  reason?: string;
}) => void;

let _iamCheckFn: KernelIAMCheckFn | null = null;
let _iamEnforced = false;

/**
 * Register the IAM check function and enforcement mode into the kernel.
 * Called once at surface bootstrap (apps/api/src/index.ts, apps/mcp middleware).
 * Safe to call multiple times — idempotent overwrite.
 *
 * @param checkFn  The full IAM resolver (fetches authz + runs resolve + emits audit).
 * @param enforced When true, denied invocations are blocked and a CapabilityError is thrown.
 *                 When false (default), denied decisions are logged but the call proceeds.
 */
export function setKernelIAMRuntime(
  checkFn: KernelIAMCheckFn,
  enforced: boolean,
): void {
  _iamCheckFn = checkFn;
  _iamEnforced = enforced;
}

/** Remove the IAM runtime. Used in tests to reset state. */
export function clearKernelIAMRuntime(): void {
  _iamCheckFn = null;
  _iamEnforced = false;
}

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
  | "authz_denied"
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

// ---------------------------------------------------------------------------
// Security event emitter — pluggable, fire-and-forget.
//
// Surfaces (api/mcp bootstraps) inject the emitter once via
// `setSecurityEventEmitter`. The kernel calls it after every capability
// invocation attempt (allow / deny / error) without awaiting the result so
// the audit write never blocks the response path.
//
// Keeping the emitter behind a setter rather than a static import means:
//   - The kernel has no dependency on @oxagen/database or @oxagen/telemetry.
//   - Tests can inject a spy or omit the emitter entirely.
//   - The emitter is optional: if no emitter is registered (e.g. local dev
//     without a DB), invocations proceed normally.
// ---------------------------------------------------------------------------

export type KernelSecurityOutcome = "allow" | "deny" | "error";

export interface KernelSecurityEvent {
  capability: string;
  outcome: KernelSecurityOutcome;
  /**
   * Surface the call arrived on. Combines both CapabilityContext.surface
   * (api/mcp/app/runner) and CapabilitySurface (api/mcp/agent) since
   * opts.surface may be "agent" while ctx.surface is always a transport-level
   * surface. The emitter should coerce unknown values to a safe fallback.
   */
  surface: string | undefined;
  orgId: string;
  workspaceId: string;
  actorUserId: string | null;
  requestId: string;
  /** The CapabilityErrorCode that caused a deny/error, if any. */
  errorCode: CapabilityErrorCode | null;
  /** Wall-clock milliseconds from invoke() entry to emit. */
  durationMs: number;
}

type SecurityEventEmitter = (event: KernelSecurityEvent) => void;

let _securityEventEmitter: SecurityEventEmitter | null = null;

/**
 * Register a fire-and-forget emitter for capability authz events.
 * Call once during surface bootstrap (API server startup, MCP init, etc.).
 * Re-registration is intentionally allowed — surfaces that restart can
 * re-register without a process restart.
 */
export function setSecurityEventEmitter(emitter: SecurityEventEmitter): void {
  _securityEventEmitter = emitter;
}

/** Remove the current emitter. Primarily used in tests. */
export function clearSecurityEventEmitter(): void {
  _securityEventEmitter = null;
}

function emitSecurityEvent(event: KernelSecurityEvent): void {
  if (_securityEventEmitter) {
    try {
      _securityEventEmitter(event);
    } catch {
      // Never let a broken emitter crash a capability invocation.
      // Silence — the surface's emitter implementation should handle its own errors.
    }
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
 * contract schema, runs the IAM check (OXA-1498), runs the bound handler, and
 * validates the output so a drifting handler can never return a shape that
 * violates the contract.
 *
 * IAM behaviour (controlled by setKernelIAMRuntime):
 *   - When an IAM check function is registered:
 *       ALWAYS resolves authz and emits the ClickHouse audit event.
 *       When enforcement=true (IAM_ENFORCEMENT_ENABLED=true):
 *         returns DenialResponse | throws on deny/pending_approval.
 *       When enforcement=false (default):
 *         logs would-deny decisions and proceeds — zero lockout risk.
 *   - When no IAM check function is registered: proceeds as before (no IAM).
 *
 * Emits a `KernelSecurityEvent` after every invocation attempt — allow,
 * deny (surface/input/unknown errors), or error (output validation / handler
 * throw). The emit is fire-and-forget; the capability response is never
 * delayed by the audit write.
 */
export async function invoke(
  name: string,
  rawInput: unknown,
  ctx: CapabilityContext,
  opts: InvokeOptions = {},
): Promise<unknown> {
  const startMs = Date.now();
  const cap = getCapability(name);
  if (!cap) {
    emitSecurityEvent({
      capability: name,
      outcome: "deny",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: "unknown_capability",
      durationMs: Date.now() - startMs,
    });
    throw new CapabilityError(name, "unknown_capability", `Unknown capability "${name}"`);
  }

  if (opts.surface && !getSurfaces(cap).includes(opts.surface)) {
    emitSecurityEvent({
      capability: name,
      outcome: "deny",
      surface: opts.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: "surface_denied",
      durationMs: Date.now() - startMs,
    });
    throw new CapabilityError(
      name,
      "surface_denied",
      `Capability "${name}" is not exposed on the "${opts.surface}" surface`,
    );
  }

  const inputResult = cap.input.safeParse(rawInput);
  if (!inputResult.success) {
    emitSecurityEvent({
      capability: name,
      outcome: "error",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: "invalid_input",
      durationMs: Date.now() - startMs,
    });
    throw new CapabilityError(
      name,
      "invalid_input",
      `Input validation failed for "${name}": ${inputResult.error.message}`,
    );
  }

  // ── IAM check (OXA-1498) ───────────────────────────────────────────────────
  // Run after input validation (we need the parsed input for the audit hash).
  // ALWAYS runs when checkFn is registered. Only BLOCKS when _iamEnforced=true.
  const checkFn = _iamCheckFn;
  if (checkFn !== null) {
    let rawInputJson = "{}";
    try {
      rawInputJson = JSON.stringify(inputResult.data);
    } catch {
      rawInputJson = "{}";
    }
    // defaultEffect is carried on the capability declaration; fall back to
    // "deny" for capabilities without an explicit defaultEffect (safe default).
    const defaultEffect: CapabilityEffect =
      (cap as { defaultEffect?: CapabilityEffect }).defaultEffect ?? "deny";

    // Fire-and-forget: checkFn internally emits the ClickHouse audit event.
    let iamCheckThrew = false;
    const iamResult = await checkFn({
      capability: name,
      ctx,
      defaultEffect,
      rawInputJson,
    }).catch((err: unknown) => {
      // IAM check failure is a critical incident. When enforcement is OFF we
      // must never crash an invocation (log loudly and fall through), but when
      // enforcement is ON we MUST fail closed — a transient resolver error
      // (DB timeout, network blip, misconfig) must not silently grant access.
      // Flag the throw and decide based on _iamEnforced below.
      iamCheckThrew = true;
      console.error(`[kernel] IAM check threw for "${name}":`, err);
      return null;
    });

    // Fail closed on resolver error when enforcement is enabled.
    if (iamCheckThrew && _iamEnforced) {
      emitSecurityEvent({
        capability: name,
        outcome: "deny",
        surface: ctx.surface,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.userId,
        requestId: ctx.requestId,
        errorCode: "authz_denied",
        durationMs: Date.now() - startMs,
      });
      throw new CapabilityError(
        name,
        "authz_denied",
        `IAM check errored for "${name}" and IAM_ENFORCEMENT_ENABLED=true — failing closed.`,
      );
    }

    if (iamResult !== null && iamResult.outcome !== "allow") {
      if (_iamEnforced) {
        // Enforcement on: block the call.
        emitSecurityEvent({
          capability: name,
          outcome: "deny",
          surface: ctx.surface,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
          requestId: ctx.requestId,
          errorCode: "authz_denied",
          durationMs: Date.now() - startMs,
        });
        throw new CapabilityError(
          name,
          "authz_denied",
          `IAM denied "${name}" for principal: ${iamResult.reason ?? iamResult.outcome}`,
        );
      } else {
        // Enforcement off: log would-deny and continue.
        console.warn(
          `[kernel] IAM would-deny "${name}" (outcome=${iamResult.outcome}, ` +
            `reason=${iamResult.reason ?? "none"}) — IAM_ENFORCEMENT_ENABLED=false, proceeding.`,
        );
      }
    }
  }
  // ── End IAM check ─────────────────────────────────────────────────────────

  let output: unknown;
  try {
    const handler = await resolveHandler(name);
    output = await handler(inputResult.data, ctx);
  } catch (err) {
    // Distinguish CapabilityError (handler not found → deny) from a
    // handler runtime throw (→ error).
    const isCapErr = err instanceof CapabilityError;
    emitSecurityEvent({
      capability: name,
      outcome: isCapErr && err.code === "no_handler" ? "deny" : "error",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: isCapErr ? err.code : null,
      durationMs: Date.now() - startMs,
    });
    throw err;
  }

  const outputResult = cap.output.safeParse(output);
  if (!outputResult.success) {
    emitSecurityEvent({
      capability: name,
      outcome: "error",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: "invalid_output",
      durationMs: Date.now() - startMs,
    });
    throw new CapabilityError(
      name,
      "invalid_output",
      `Output validation failed for "${name}": ${outputResult.error.message}`,
    );
  }

  // Successful invocation.
  emitSecurityEvent({
    capability: name,
    outcome: "allow",
    surface: ctx.surface,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.userId,
    requestId: ctx.requestId,
    errorCode: null,
    durationMs: Date.now() - startMs,
  });

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
