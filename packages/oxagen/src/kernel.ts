import type { CapabilityContext, CapabilitySurface, CapabilityEffect, ResolvedPrincipal } from "./types";
import { getSurfaces } from "./types";
import { getCapability, listCapabilities } from "./registry";
import { pluginForContract } from "./plugins/registry";
import { runInTenantScope } from "@oxagen/tenancy";

// ── Billing admission gate (injected at bootstrap) ───────────────────────────
//
// The kernel accepts a pluggable billing gate so it carries no direct
// dependency on @oxagen/billing. The gate is registered once at service
// bootstrap (apps/api/src/index.ts, apps/mcp middleware, apps/app server
// component init) via `setBillingAdmissionGate`.
//
// The gate fires AFTER IAM (billing shouldn't gate admin calls) and BEFORE
// the handler runs. Capabilities tagged `noBillingGate: true` skip the check.
// When no gate is registered (tests, CLI) the call proceeds.

export type BillingAdmissionGateFn = (orgId: string) => Promise<void>;

let _billingGate: BillingAdmissionGateFn | null = null;

/**
 * Register the billing admission gate. Call once at service bootstrap.
 * The gate must throw `BillingSuspendedError` or `InsufficientCreditsError`
 * (from @oxagen/billing) to refuse a turn.
 */
export function setBillingAdmissionGate(gate: BillingAdmissionGateFn): void {
  _billingGate = gate;
}

/** Remove the billing gate. Used in tests. */
export function clearBillingAdmissionGate(): void {
  _billingGate = null;
}

// ── Capability entitlement gate (injected at bootstrap) ──────────────────────
//
// Mirrors the billing admission gate pattern. The gate is registered once at
// service bootstrap (apps/api/src/index.ts, apps/mcp middleware, apps/app
// server component init) via `setCapabilityEntitlementGate`.
//
// The gate fires AFTER the billing gate and only for capabilities whose
// contract is claimed by a plugin (pluginForContract returns a manifest).
// Builtin capabilities (unclaimed contracts) always bypass the gate.
//
// When no gate is registered (tests, CLI, system invocations) the call
// proceeds unconditionally — matches the IAM/billing default-open injection
// pattern; all three apps bootstrap it.
//
// The gate must throw `CapabilityError(name, "capability_not_installed", ...)`
// to refuse a turn. Use `capabilityNotInstalledError()` below to produce the
// canonical error shape.

export type CapabilityEntitlementGateFn = (
  capabilityName: string,
  orgId: string,
) => Promise<void>;

let _entitlementGate: CapabilityEntitlementGateFn | null = null;

/**
 * Register the capability entitlement gate. Call once at service bootstrap.
 * The gate must throw a CapabilityError with code "capability_not_installed"
 * to refuse access (use `capabilityNotInstalledError()` for the canonical shape).
 */
export function setCapabilityEntitlementGate(gate: CapabilityEntitlementGateFn): void {
  _entitlementGate = gate;
}

/** Remove the capability entitlement gate. Used in tests. */
export function clearCapabilityEntitlementGate(): void {
  _entitlementGate = null;
}

/**
 * Canonical "plugin not installed" error for use by the entitlement gate
 * implementation in packages/plugins. Carries the plugin id and a direct
 * install hint so the error message is actionable on every surface.
 */
export function capabilityNotInstalledError(
  capability: string,
  pluginId: string,
  pluginName: string,
): CapabilityError {
  return new CapabilityError(
    capability,
    "capability_not_installed",
    `Capability "${capability}" requires the "${pluginName}" plugin (${pluginId}). Install and enable it from the marketplace.`,
  );
}

// ── IAM runtime injection ─────────────────────────────────────────────────────
//
// The kernel accepts an injected IAMCheckFn / audit-emitter so the single
// kernel.invoke() dispatch path can run the full IAM resolution + ClickHouse
// audit write on EVERY capability call.
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
// Tracks which side-effect register modules have already run against THIS
// kernel-module instance. Lives in the same module scope as `loaders` so the
// two always reset together: when a dev bundler (Turbopack HMR) invalidates the
// kernel it invalidates its importers too, so a fresh `loaders` always comes
// with a fresh `registeredTokens`. See `registerHandlersOnce`.
const registeredTokens = new Set<string>();

export type CapabilityErrorCode =
  | "unknown_capability"
  | "no_handler"
  | "surface_denied"
  | "authz_denied"
  | "invalid_input"
  | "invalid_output"
  | "capability_not_installed";

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
  /**
   * The CapabilityErrorCode that caused a deny/error, if any. Includes
   * "no_tenant_scope" for the fail-closed tenant-scope denial (OXA-1515).
   */
  errorCode: CapabilityErrorCode | "no_tenant_scope" | null;
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

/**
 * Run a side-effect register block exactly once per kernel-module instance.
 *
 * Side-effect register modules (`@oxagen/handlers/register`,
 * `@oxagen/agent/register`) call `registerHandler` at module-eval time. Under a
 * dev bundler these modules can be re-evaluated on hot reload while the kernel
 * module's `loaders` Map survives — re-running the registrations would then trip
 * the duplicate guard in `registerHandler` and crash the surface. Wrapping a
 * register module's body in this helper makes re-evaluation a no-op while
 * keeping `registerHandler` strict (genuine in-file/cross-module duplicates
 * still throw on the first, real registration pass).
 */
export function registerHandlersOnce(token: string, register: () => void): void {
  if (registeredTokens.has(token)) return;
  registeredTokens.add(token);
  register();
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
 *         throws CapabilityError(code='authz_denied') on deny or pending_approval.
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

  // ── Scope wrapper helper ──────────────────────────────────────────────────
  // For SCOPED capabilities, the IAM check, billing admission gate, and handler
  // must ALL run inside ONE runInTenantScope so that withTenantDb seams in
  // fetchAuthz (IAM) and consumeCredits/assertOrgCanConsume (billing) can
  // resolve the active scope. For UNSCOPED capabilities (cap.scoped === false,
  // e.g. user.preferences.write) we must NOT wrap — the ids are empty and
  // runInTenantScope would throw TenantScopeError (OXA-1515). — OXA-1697
  const isScoped = cap.scoped !== false;
  const withScope = isScoped
    ? <T>(fn: () => Promise<T>): Promise<T> =>
        runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, fn)
    : <T>(fn: () => Promise<T>): Promise<T> => fn();

  // ── IAM + billing + handler (all inside scope for scoped caps) ───────────
  let output: unknown;
  try {
    output = await withScope(async () => {
      // ── IAM check (OXA-1498) ───────────────────────────────────────────────
      // Run after input validation (we need the parsed input for the audit hash).
      // ALWAYS runs when checkFn is registered. Only BLOCKS when _iamEnforced=true.
      // fetchAuthz uses withTenantDb, so the scope must be active here — OXA-1697.
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
      // ── End IAM check ───────────────────────────────────────────────────────

      // ── Billing admission gate ───────────────────────────────────────────────
      // Runs after IAM (so admin/billing capabilities bypass the credit check).
      // Only fires when orgId is present AND noBillingGate is not true on the
      // contract. Capabilities tagged noBillingGate:true (API key creation,
      // member management, settings, etc.) skip the gate — they don't consume
      // AI tokens and must not be blocked by a zero credit balance.
      // assertOrgCanConsume uses withTenantDb, so the scope must be active — OXA-1697.
      // Gate throws BillingSuspendedError or InsufficientCreditsError to refuse.
      const skipBilling = (cap as { noBillingGate?: boolean }).noBillingGate === true;
      if (_billingGate !== null && ctx.orgId && !skipBilling) {
        await _billingGate(ctx.orgId);
      }
      // ── End billing admission gate ───────────────────────────────────────────

      // ── Capability entitlement gate ──────────────────────────────────────────
      // Runs after the billing gate. Only fires when:
      //   1. The contract is claimed by a registered plugin (builtin contracts
      //      are always available — no gate call).
      //   2. A gate function has been registered (default-open when absent,
      //      matching the IAM/billing injection pattern — all three apps
      //      bootstrap it via bootstrapEntitlementRuntime()).
      //   3. orgId is non-empty (system/internal invocations — e.g. Inngest
      //      background jobs that carry no org context — skip the gate to
      //      avoid locking out platform-internal work).
      // The gate throws CapabilityError(code="capability_not_installed") to
      // refuse. Use capabilityNotInstalledError() for the canonical shape.
      const claimingPlugin = pluginForContract(name);
      if (claimingPlugin !== undefined && _entitlementGate !== null && ctx.orgId) {
        await _entitlementGate(name, ctx.orgId);
      }
      // ── End capability entitlement gate ─────────────────────────────────────

      const handler = await resolveHandler(name);
      return handler(inputResult.data, ctx);
    });
  } catch (err) {
    // Distinguish CapabilityError (handler not found → deny) from a
    // handler runtime throw (→ error). A TenantScopeError (e.g. the MCP
    // orgId:"" fail-open path) carries a stable `code` we surface to the
    // audit chain so the denial reason is explainable (SOC 2 forensics).
    const isCapErr = err instanceof CapabilityError;
    const scopeCode =
      err instanceof Error && "code" in err && err.code === "no_tenant_scope"
        ? "no_tenant_scope"
        : null;
    emitSecurityEvent({
      capability: name,
      outcome:
        (isCapErr && err.code === "no_handler") || scopeCode ? "deny" : "error",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: isCapErr ? err.code : scopeCode,
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

// ── External-tool IAM check helper (OXA-1390, agent-runtime gap-4) ──────────
//
// The agent runtime dispatches external MCP tools under synthetic capability
// ids of the form `mcp.<server>.<tool>`. Those ids are never registered in
// the capability registry (no defineContract / handler), so kernel.invoke()
// cannot be used to policy-check them. This helper runs the SAME gate that
// kernel.invoke() uses — _iamCheckFn + _iamEnforced semantics + security
// event emit — without requiring a registered handler or contract.
//
// Usage:
//   const { allowed } = await authorizeExternalCapability(
//     "mcp.github.list_pull_requests",
//     ctx,
//     "deny", // default effect when no explicit grant exists
//   );
//   if (!allowed) throw new McpToolDeniedError(...);
//
// The caller (agent runtime / materialize-tools) is responsible for deciding
// what to do with the result. This helper never throws on deny (unlike
// kernel.invoke() with enforcement=true) — it returns a typed result so the
// caller can apply the appropriate error shape for its transport.

export interface AuthorizeExternalCapabilityResult {
  /** True when the IAM check passed (outcome === "allow" OR enforcement is off). */
  allowed: boolean;
  /** The IAM outcome string: "allow" | "deny" | "pending_approval". */
  outcome: string;
  /** Human-readable denial reason, or null when allowed. */
  reason: string | null;
}

/**
 * Policy-check a synthetic capability id (e.g. `mcp.<server>.<tool>`) without
 * requiring a registered contract or handler. Runs the same IAM gate that
 * kernel.invoke() uses:
 *
 *   1. Calls _iamCheckFn (if registered) with the synthetic capability name.
 *   2. Applies _iamEnforced semantics:
 *        - enforced=true  → allowed=false when outcome !== "allow"
 *        - enforced=false → allowed=true (but outcome/reason reflect would-deny)
 *   3. Emits a KernelSecurityEvent for the audit trail (fire-and-forget).
 *
 * When no IAM runtime is registered (tests / local dev without bootstrap),
 * the call is unconditionally allowed and emits no event — mirrors the
 * kernel.invoke() behaviour under the same conditions.
 *
 * @param name          Synthetic capability id, e.g. "mcp.github.list_pull_requests".
 * @param ctx           CapabilityContext built at the surface entry seam.
 * @param defaultEffect Fallback effect when no explicit grant/policy matches.
 */
export async function authorizeExternalCapability(
  name: string,
  ctx: CapabilityContext,
  defaultEffect: "allow" | "deny",
): Promise<AuthorizeExternalCapabilityResult> {
  const startMs = Date.now();
  const checkFn = _iamCheckFn;

  if (checkFn === null) {
    // No IAM runtime registered — unconditionally allow (mirrors kernel.invoke()).
    return { allowed: true, outcome: "allow", reason: null };
  }

  let iamCheckThrew = false;
  const iamResult = await checkFn({
    capability: name,
    ctx,
    defaultEffect,
    rawInputJson: "null",
  }).catch((err: unknown) => {
    iamCheckThrew = true;
    console.error(`[kernel:external] IAM check threw for "${name}":`, err);
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
    return { allowed: false, outcome: "deny", reason: "iam_check_error" };
  }

  // IAM check errored but enforcement is off — allow with a warning.
  if (iamCheckThrew) {
    console.warn(
      `[kernel:external] IAM check errored for "${name}" (enforcement=off) — allowing.`,
    );
    return { allowed: true, outcome: "allow", reason: null };
  }

  const outcome = iamResult?.outcome ?? "deny";
  const reason = iamResult && "reason" in iamResult ? (iamResult.reason ?? null) : null;
  const isDenied = outcome !== "allow";

  emitSecurityEvent({
    capability: name,
    outcome: isDenied ? "deny" : "allow",
    surface: ctx.surface,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.userId,
    requestId: ctx.requestId,
    errorCode: isDenied ? "authz_denied" : null,
    durationMs: Date.now() - startMs,
  });

  if (isDenied) {
    if (_iamEnforced) {
      return { allowed: false, outcome, reason: reason ?? outcome };
    }
    // Enforcement off — log would-deny and allow.
    console.warn(
      `[kernel:external] IAM would-deny "${name}" (outcome=${outcome}, ` +
        `reason=${reason ?? "none"}) — IAM_ENFORCEMENT_ENABLED=false, allowing.`,
    );
    return { allowed: true, outcome, reason: reason ?? outcome };
  }

  return { allowed: true, outcome: "allow", reason: null };
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
  registeredTokens.clear();
}
