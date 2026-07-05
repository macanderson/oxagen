import type { CapabilityContext, CapabilitySurface, CapabilityEffect, ResolvedPrincipal } from "./types";
import { getSurfaces } from "./types";
import { getCapability, listCapabilities } from "./registry";
import { pluginForContract } from "./plugins/registry";
import { runInTenantScope } from "@oxagen/tenancy";
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";

// Matches runInTenantScope's own uuid guard: we only enter a tenant scope when
// both tenant ids are valid uuids, otherwise runInTenantScope() fail-closes.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

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
  workspaceId: string,
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

// ---------------------------------------------------------------------------
// Capability trace sink — pluggable, fire-and-forget.
//
// Where the security emitter records the AUTHZ outcome of every call, the trace
// sink records the EXECUTION of a call: the validated input, the validated
// output, timing, and the request/message correlation ids. It is the durable
// substrate for the chain-of-thought inspection UI and the downloadable
// per-subagent logfiles ("traceable down to individual queries and results").
//
// Like the security emitter it is injected once at surface bootstrap, never
// awaited (the response path is never delayed by a trace write), and never
// allowed to throw into a capability invocation. When no sink is registered the
// call proceeds with zero overhead. The sink implementation decides persistence
// and any input/output redaction — the kernel hands over the raw validated data
// since the inspection surface needs to show real values.
// ---------------------------------------------------------------------------

export interface KernelTraceEvent {
  capability: string;
  /** "ok" when the handler ran and output validated; "error" otherwise. */
  status: "ok" | "error";
  /**
   * Surface the call arrived on (CapabilitySurface from opts.surface when set,
   * else the transport-level ctx.surface).
   */
  surface: string | undefined;
  orgId: string;
  workspaceId: string;
  actorUserId: string | null;
  /** Correlates every call in one request/turn. */
  requestId: string;
  /** Correlates calls to a chat message DAG node; null off the chat surface. */
  messageId: string | null;
  /**
   * The validated input passed to the handler, or the raw input when validation
   * failed before the handler ran. The sink owns any redaction.
   */
  input: unknown;
  /** The validated output — present only when status === "ok". */
  output?: unknown;
  /** Failure code when status === "error". */
  errorCode?: CapabilityErrorCode | "no_tenant_scope";
  /** Wall-clock milliseconds from invoke() entry to emit. */
  durationMs: number;
}

type KernelTraceSink = (event: KernelTraceEvent) => void;

let _traceSink: KernelTraceSink | null = null;

/**
 * Register a fire-and-forget trace sink. Call once during surface bootstrap.
 * Re-registration is allowed (matches the security emitter) so a restarting
 * surface can re-register without a process restart.
 */
export function setKernelTraceSink(sink: KernelTraceSink): void {
  _traceSink = sink;
}

/** Remove the current trace sink. Primarily used in tests. */
export function clearKernelTraceSink(): void {
  _traceSink = null;
}

function emitTraceEvent(event: KernelTraceEvent): void {
  if (_traceSink) {
    try {
      _traceSink(event);
    } catch {
      // A broken trace sink must never crash a capability invocation.
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
 *       When checkFn THROWS (resolver error — DB down, migration missing,
 *         resolver bug): ALWAYS fails closed (throws CapabilityError,
 *         code='authz_denied')), regardless of the enforcement flag (OXA-2056).
 *         A throw means the check could not be evaluated at all —
 *         categorically different from a policy "deny" decision, which is the
 *         only case the enforcement flag is allowed to soften. Silently
 *         granting access because the resolver happened to error is a
 *         fail-open bug, not graceful degradation.
 *   - When no IAM check function is registered: proceeds as before (no IAM).
 *
 * Emits a `KernelSecurityEvent` after every invocation attempt — allow,
 * deny (surface/input/unknown errors), or error (output validation / handler
 * throw). The emit is fire-and-forget; the capability response is never
 * delayed by the audit write.
 */
/**
 * The one dispatch path. Starts an OpenTelemetry span for the invocation and
 * delegates to _invokeCore which contains the full IAM → billing → handler
 * pipeline. The span is "active" for the entire invocation, so child async
 * operations (ClickHouse inserts, AI calls) can read it via
 * trace.getActiveSpan() → currentTraceIds() for log↔trace correlation.
 *
 * No-op when the OTEL SDK is not initialised (global NoopTracer).
 */
export async function invoke(
  name: string,
  rawInput: unknown,
  ctx: CapabilityContext,
  opts: InvokeOptions = {},
): Promise<unknown> {
  return trace.getTracer("oxagen.kernel").startActiveSpan(
    "kernel.invoke",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "capability.name": name,
        "capability.surface": opts.surface ?? ctx.surface ?? "",
        "tenant.org_id": ctx.orgId,
        "tenant.workspace_id": ctx.workspaceId,
        "request.id": ctx.requestId,
      },
    },
    async (span) => {
      try {
        const result = await _invokeCore(name, rawInput, ctx, opts);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }
    },
  );
}

/**
 * Core invocation logic: resolve contract, validate input, run IAM + billing
 * + entitlement gates, invoke handler, validate output. Called by invoke()
 * inside an active OTEL span so trace context propagates to all child ops.
 */
async function _invokeCore(
  name: string,
  rawInput: unknown,
  ctx: CapabilityContext,
  opts: InvokeOptions,
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
    emitTraceEvent({
      capability: name,
      status: "error",
      surface: opts.surface ?? ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      messageId: ctx.messageId,
      input: rawInput,
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
  //
  // BUT: "unscoped" describes the handler's data ownership, not the IAM gate.
  // The IAM check (checkIAM → fetchAuthz → withTenantDb) ALWAYS needs an active
  // tenant scope when it runs the enterprise resolver — and some unscoped
  // handlers also read through withTenantDb (e.g. plugin.schema.get's
  // connector_schemas cache). An unscoped capability that still carries real
  // tenant ids (e.g. plugin.schema.get, invoked with a concrete org+workspace)
  // therefore MUST enter a scope, or fetchAuthz throws TenantScopeError and the
  // kernel fail-closes with "IAM check errored … failing closed". So we enter a
  // scope whenever the capability is scoped OR both tenant ids are valid uuids;
  // we only skip the wrap for the empty/invalid-id case (user.preferences.write,
  // MCP session-token path), where runInTenantScope would reject the ids.
  const isScoped = cap.scoped !== false;
  const hasTenantIds = isUuid(ctx.orgId) && isUuid(ctx.workspaceId);
  const withScope =
    isScoped || hasTenantIds
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
          // IAM check failure is a critical incident — the check could not be
          // evaluated at all (DB down, migration missing, resolver bug). This
          // is categorically different from a policy "deny" decision: a deny
          // decision legitimately still respects _iamEnforced (would-deny +
          // log during the rollout window), but an UNEVALUATED check must
          // never silently grant access. Flag the throw; the unconditional
          // fail-closed below does NOT consult _iamEnforced (OXA-2056 — the
          // prior `iamCheckThrew && _iamEnforced` gate fell through to
          // fail-open whenever enforcement was off, which defeats the entire
          // point of failing closed on an evaluation failure).
          iamCheckThrew = true;
          console.error(`[kernel] IAM check threw for "${name}":`, err);
          return null;
        });

        // Fail closed on resolver error UNCONDITIONALLY — never gated on
        // _iamEnforced. See OXA-2056.
        if (iamCheckThrew) {
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
            `IAM check errored for "${name}" — failing closed (unconditional; independent of IAM_ENFORCEMENT_ENABLED, OXA-2056).`,
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
      // Only fires when orgId is present, noBillingGate is not true on the
      // contract, AND the capability is SCOPED. Capabilities tagged
      // noBillingGate:true (API key creation, member management, settings, etc.)
      // skip the gate — they don't consume AI tokens and must not be blocked by a
      // zero credit balance.
      //
      // The gate's assertOrgCanConsume / effectiveBalance use withTenantDb, which
      // requires an active tenant scope. The kernel only establishes that scope
      // (runInTenantScope above) for SCOPED capabilities — so running the gate for
      // an UNSCOPED capability (cap.scoped === false, e.g. plugin.schema.get) threw
      // "No active tenant scope" and 500'd the call before the handler ran (this
      // broke the connector Configure form). Unscoped capabilities are global,
      // read-only fetches — never metered AI turns — so skipping the gate for them
      // is correct as well as necessary. — OXA-1697.
      const skipBilling = (cap as { noBillingGate?: boolean }).noBillingGate === true;
      if (_billingGate !== null && ctx.orgId && !skipBilling && isScoped) {
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
      if (
        claimingPlugin !== undefined &&
        _entitlementGate !== null &&
        ctx.orgId &&
        ctx.workspaceId
      ) {
        // Entitlement is workspace-scoped: a capability pack installed in one
        // workspace does not entitle sibling workspaces in the same org.
        await _entitlementGate(name, ctx.orgId, ctx.workspaceId);
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
    emitTraceEvent({
      capability: name,
      status: "error",
      surface: opts.surface ?? ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      messageId: ctx.messageId,
      input: inputResult.data,
      errorCode: isCapErr ? err.code : (scopeCode ?? undefined),
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
    emitTraceEvent({
      capability: name,
      status: "error",
      surface: opts.surface ?? ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      messageId: ctx.messageId,
      input: inputResult.data,
      output,
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
  emitTraceEvent({
    capability: name,
    status: "ok",
    surface: opts.surface ?? ctx.surface,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.userId,
    requestId: ctx.requestId,
    messageId: ctx.messageId,
    input: inputResult.data,
    output: outputResult.data,
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
 *   2. Applies _iamEnforced semantics to a resolved policy DECISION:
 *        - enforced=true  → allowed=false when outcome !== "allow"
 *        - enforced=false → allowed=true (but outcome/reason reflect would-deny)
 *      A checkFn THROW (evaluation failure, not a decision) always fails
 *      closed regardless of _iamEnforced — see OXA-2056.
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
    // A throw is an evaluation failure, not a policy decision — it must
    // always fail closed, independent of _iamEnforced. See kernel.invoke()'s
    // matching comment above; the same OXA-2056 rationale applies here.
    iamCheckThrew = true;
    console.error(`[kernel:external] IAM check threw for "${name}":`, err);
    return null;
  });

  // Fail closed on resolver error UNCONDITIONALLY — never gated on
  // _iamEnforced. See OXA-2056 (a prior `iamCheckThrew && _iamEnforced` gate
  // here fell through to an unconditional allow whenever enforcement was
  // off, silently disabling authorization for every external-tool call while
  // the resolver was erroring).
  if (iamCheckThrew) {
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
