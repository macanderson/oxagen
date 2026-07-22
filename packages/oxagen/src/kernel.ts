import type {
  CapabilityContext,
  CapabilitySurface,
  CapabilityEffect,
  DeployedAgentInvocationContext,
  LifecycleExecutionContext,
  CheckedContext,
  ResolvedPrincipal,
} from "./types";
import type { AuthorizationDecisionRef } from "./iam/agent-run";
import { getSurfaces } from "./types";
import { getCapability, listCapabilities } from "./registry";
import { pluginForContract } from "./plugins/registry";
import { runInTenantScope, runWithPrincipal } from "@oxagen/tenancy";
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

// ── Budget admission gate (injected at bootstrap) ────────────────────────────
//
// A hard PERIOD-TO-DATE spend ceiling (OXA-1079). Mirrors the billing admission
// gate: the kernel carries no dependency on @oxagen/billing — the gate is
// injected once at service bootstrap (bootstrapBillingRuntime) via
// `setBudgetAdmissionGate`, and throws @oxagen/billing's own BudgetExceededError
// (a plain Error with `code === "budget_exceeded"`, duck-typed at the surfaces)
// to refuse a turn.
//
// It fires AFTER the billing admission gate (a suspended/zero-balance org is
// refused first) and BEFORE the entitlement gate + handler, INSIDE the tenant
// scope (its withTenantDb budget read needs the active scope). It is skipped on
// exactly the same conditions as the billing gate — unscoped capabilities and
// `noBillingGate: true` contracts (reading your own spend/budget must never be
// blocked by being over budget) — plus it needs a workspaceId (a workspace
// ceiling can't be evaluated without one). Unlike the billing gate it takes the
// full scope + capability so it can evaluate BOTH the org-level and
// workspace-level ceiling and name the denied capability.
//
// When no gate is registered (tests, CLI) the call proceeds unconditionally —
// matches the billing/IAM/entitlement default-open injection pattern.

export type BudgetAdmissionGateFn = (args: {
  orgId: string;
  workspaceId: string;
  capability: string;
}) => Promise<void>;

let _budgetGate: BudgetAdmissionGateFn | null = null;

/**
 * Register the budget admission gate. Call once at service bootstrap.
 * The gate must throw `BudgetExceededError` (from @oxagen/billing) to refuse a
 * turn — its stable `code: "budget_exceeded"` is duck-typed by the kernel catch
 * (classified as a DENY, not an error) and by the Hono/MCP error handlers (402).
 */
export function setBudgetAdmissionGate(gate: BudgetAdmissionGateFn): void {
  _budgetGate = gate;
}

/** Remove the budget gate. Used in tests. */
export function clearBudgetAdmissionGate(): void {
  _budgetGate = null;
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
export function setCapabilityEntitlementGate(
  gate: CapabilityEntitlementGateFn,
): void {
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
  /**
   * The platform-created reference to the immutable `iam.authorization_decisions`
   * row this check persisted (`azd_…`). The IAM runtime sets it for EVERY
   * outcome — allow, deny, approval-pending, and evaluation error — because a
   * governed operation with no decision row is unauditable.
   *
   * Null when the check ran on a path that persists no decision (the
   * non-enterprise human fast-path, or a surface with no IAM runtime). For an
   * AGENT-RUN invocation a null here is fatal: the kernel fails closed rather
   * than execute an operation whose authoritative decision could not be
   * written.
   */
  decision?: AuthorizationDecisionRef | null;
}

export type KernelIAMCheckFn = (args: {
  capability: string;
  ctx: CapabilityContext;
  defaultEffect: CapabilityEffect;
  rawInputJson: string;
  /**
   * The object this invocation acts on, derived from the contract's
   * declarative `audit` field (accountability chain). Threads into the IAM
   * audit row's target_kind/target_id. Null when the contract declares no
   * audit target or the input field is absent/non-string.
   */
  target?: { kind: string; id: string } | null;
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

// ── JIT access-request creator (injected at bootstrap) ───────────────────────
//
// When the IAM resolver returns `pending_approval`, the kernel must DENY the
// action now but ALSO create an org.access_requests row so an approver can
// grant it and the caller can poll for status. Creating that row is a DB write
// owned by @oxagen/iam (withTenantDb + drizzle), which depends on @oxagen/oxagen
// — so the kernel cannot import it without a dependency cycle. Instead the
// creator is injected once at surface bootstrap (packages/iam/src/bootstrap.ts
// via bootstrapIAMRuntime), mirroring the IAM-runtime injection pattern above.
//
// SECURITY INVARIANT: this seam only ADDS the pollable request id to the denial
// — it can never turn a pending_approval into an allow. A missing creator, a
// null return, or a thrown creator all still DENY (accessRequestId is simply
// absent). See the pending_approval branch in _invokeCore.

export interface KernelAccessRequestArgs {
  /** Canonical capability name being requested. */
  capability: string;
  /** The invocation context (org/workspace/user scope). */
  ctx: CapabilityContext;
  /** The IAM-resolved principal, or null when none resolved. */
  principal: ResolvedPrincipal | null;
}

/**
 * Creates an access_requests row and returns its publicId (arq_…), or null when
 * one could not be created (e.g. null principal / IAM tables absent). Runs
 * inside the kernel's active tenant scope so its withTenantDb resolves.
 */
export type KernelAccessRequestCreatorFn = (
  args: KernelAccessRequestArgs,
) => Promise<string | null>;

let _accessRequestCreator: KernelAccessRequestCreatorFn | null = null;

/**
 * Register the JIT access-request creator. Call once at surface bootstrap.
 * When absent, pending_approval denials still deny — they just carry no
 * pollable requestId.
 */
export function setKernelAccessRequestCreator(
  fn: KernelAccessRequestCreatorFn,
): void {
  _accessRequestCreator = fn;
}

/** Remove the access-request creator. Used in tests to reset state. */
export function clearKernelAccessRequestCreator(): void {
  _accessRequestCreator = null;
}

// ── Deployed-agent invocation context (kernel-created) ───────────────────────
//
// `edit_repo_file` and governed run admission are agent-only: they must run as
// a deployed agent acting for an authenticated human, BEFORE any run (and so
// any pinned ceiling) exists. That needs a context an ordinary human / API /
// MCP caller cannot fabricate.
//
// The compile-time half is the unique-symbol brand on
// `DeployedAgentInvocationContext` in types.ts — the key is unnameable outside
// that module. The runtime half is this registry, because a `as` cast defeats
// any purely structural brand: only objects this factory created are members,
// so a hand-rolled or replayed object fails the guard and is treated as absent.
//
// A WeakSet, not a Set: entries are collected with the context object, so a
// long-lived process cannot accumulate them.

const kernelIssuedDeployedAgentInvocations = new WeakSet<object>();

export interface CreateDeployedAgentInvocationArgs {
  /** The AUTHENTICATED human authorizing this invocation. */
  initiatingPrincipal: ResolvedPrincipal;
  /** The deployed agent's own delegated IAM principal (server-resolved). */
  agentPrincipal: ResolvedPrincipal;
  /** Agent public id (agt_…). */
  agentId: string;
  /** Internal UUID of the ACTIVE agent version (server-resolved). */
  agentVersionId: string;
  /** `sha256:<64 hex>` checksum of that exact version. */
  agentVersionChecksum: string;
}

/**
 * Mint a `DeployedAgentInvocationContext`. The ONLY way to obtain one.
 *
 * Every field is server-resolved by the trusted caller (the admission path
 * resolves the active deployed-agent version and the authenticated session's
 * principal); nothing here is threaded from a request body. There is
 * deliberately no run id parameter — a caller that could name a run could
 * borrow that run's pinned ceiling.
 */
export function createDeployedAgentInvocationContext(
  args: CreateDeployedAgentInvocationArgs,
): DeployedAgentInvocationContext {
  const ctx = {
    principalKind: "deployed_agent_invocation",
    initiatingPrincipal: args.initiatingPrincipal,
    agentPrincipal: args.agentPrincipal,
    agentId: args.agentId,
    agentVersionId: args.agentVersionId,
    agentVersionChecksum: args.agentVersionChecksum,
  } as unknown as DeployedAgentInvocationContext;
  kernelIssuedDeployedAgentInvocations.add(ctx);
  return ctx;
}

/**
 * True only for a context this kernel actually minted. Surfaces gating an
 * agent-only capability MUST use this rather than a truthiness check on
 * `ctx.deployedAgentInvocation` — the field is structurally forgeable, the
 * registry membership is not.
 */
export function isKernelIssuedDeployedAgentInvocation(
  value: DeployedAgentInvocationContext | undefined | null,
): value is DeployedAgentInvocationContext {
  return (
    value !== undefined &&
    value !== null &&
    kernelIssuedDeployedAgentInvocations.has(value)
  );
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
  ctx: CheckedContext,
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
  // A "require_approval" IAM resolution: the action is DENIED right now, but a
  // JIT access request has been created so an approver can grant it and the
  // caller can poll for status. Distinct from "authz_denied" (a hard deny that
  // is never pollable) so surfaces can serialize the pollable requestId. See
  // the pending_approval branch in _invokeCore and setKernelAccessRequestCreator.
  | "pending_approval"
  | "invalid_input"
  | "invalid_output"
  | "capability_not_installed"
  | "lifecycle_not_allowed"
  | "lifecycle_event_denied"
  | "lifecycle_context_invalid"
  | "lifecycle_recursion_denied";

export class CapabilityError extends Error {
  constructor(
    readonly capability: string,
    readonly code: CapabilityErrorCode,
    message: string,
    /**
     * Present only on a "pending_approval" denial — the publicId (arq_…) of the
     * org.access_requests row created for this invocation, so the caller can
     * poll for approval status. Additive: never set on any other code.
     */
    readonly accessRequestId?: string,
    /**
     * The platform-created `azd_…` reference to the immutable authorization
     * decision that produced this denial / approval-pending / evaluation
     * error. The handler never ran, so there is no CheckedContext to carry it —
     * the worker reads it off the error and persists it in the run's denial or
     * terminal event, which is what makes a denied attempt as auditable as an
     * allowed one.
     */
    readonly decision?: AuthorizationDecisionRef,
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
   * "no_tenant_scope" for the fail-closed tenant-scope denial (OXA-1515) and
   * "budget_exceeded" for the hard spend-ceiling denial (OXA-1079).
   */
  errorCode: CapabilityErrorCode | "no_tenant_scope" | "budget_exceeded" | null;
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
  errorCode?: CapabilityErrorCode | "no_tenant_scope" | "budget_exceeded";
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
export function registerHandlersOnce(
  token: string,
  register: () => void,
): void {
  if (registeredTokens.has(token)) return;
  registeredTokens.add(token);
  register();
}

async function resolveHandler(name: string): Promise<CapabilityHandlerFn> {
  const cached = cache.get(name);
  if (cached) return cached;
  // ADR-025: `name` is the canonical verb-first snake_case name (callers resolve
  // through getCapability first) and the handler-registration modules bind their
  // loaders under that same snake name — so an exact lookup is all that's needed.
  // Aliases were removed entirely; there is no dotted fallback.
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
  /** Internal deterministic lifecycle execution; orthogonal to public surfaces. */
  execution?: LifecycleExecutionContext;
}

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
  // The identity for this invocation. getCapability performs an exact registry
  // lookup (ADR-025 removed alias resolution — see resolveHandler's own comment
  // below), so cap.name always equals name when a capability is found. For an
  // unknown name (cap === undefined) canonical falls back to the raw name so
  // the "unknown capability" telemetry still records what was actually called.
  const canonical = cap?.name ?? name;
  if (!cap) {
    emitSecurityEvent({
      capability: canonical,
      outcome: "deny",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: "unknown_capability",
      durationMs: Date.now() - startMs,
    });
    throw new CapabilityError(
      name,
      "unknown_capability",
      `Unknown capability "${name}"`,
    );
  }

  // ── Forged platform bindings (SECURITY, run-evidence spec Task 5) ─────────
  //
  // Two fields on the context are PLATFORM-CREATED and must never arrive from
  // a caller:
  //
  //   authorizationDecision   written only by the kernel, only onto a
  //                           CheckedContext, only from a decision row the IAM
  //                           runtime actually inserted;
  //   deployedAgentInvocation minted only by createDeployedAgentInvocationContext
  //                           and tracked in the kernel's own registry.
  //
  // Reject the invocation rather than silently stripping the field. Stripping
  // would let the probe succeed and leave no trace; a hard deny plus a security
  // event is what makes a forgery attempt visible.
  const forgedBinding =
    (ctx as { authorizationDecision?: unknown }).authorizationDecision !==
    undefined
      ? "authorizationDecision"
      : ctx.deployedAgentInvocation !== undefined &&
          !isKernelIssuedDeployedAgentInvocation(ctx.deployedAgentInvocation)
        ? "deployedAgentInvocation"
        : null;
  if (forgedBinding !== null) {
    emitSecurityEvent({
      capability: canonical,
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
      `Caller-supplied "${forgedBinding}" on the capability context for "${name}" — ` +
        "that binding is platform-created and can never be an input; failing closed.",
    );
  }

  const lifecycleExecution = opts.execution;
  if (lifecycleExecution) {
    if (ctx.surface !== "runner" || opts.surface !== undefined) {
      throw new CapabilityError(
        name,
        "lifecycle_context_invalid",
        `Lifecycle capability "${name}" must originate from the runner without a public surface`,
      );
    }
    if (lifecycleExecution.depth !== 0) {
      throw new CapabilityError(
        name,
        "lifecycle_recursion_denied",
        `Lifecycle capability "${name}" cannot recursively dispatch lifecycle events`,
      );
    }
    const lifecycle = cap.lifecycle;
    if (!lifecycle) {
      throw new CapabilityError(
        name,
        "lifecycle_not_allowed",
        `Capability "${name}" has not opted into lifecycle execution`,
      );
    }
    if (!lifecycle.allowedEvents.includes(lifecycleExecution.event)) {
      throw new CapabilityError(
        name,
        "lifecycle_event_denied",
        `Capability "${name}" does not allow lifecycle event "${lifecycleExecution.event}"`,
      );
    }
    if (
      !lifecycleExecution.idempotencyKey ||
      !lifecycleExecution.invocationId
    ) {
      throw new CapabilityError(
        name,
        "lifecycle_context_invalid",
        `Lifecycle capability "${name}" requires invocation and idempotency identifiers`,
      );
    }
  }

  if (opts.surface && !getSurfaces(cap).includes(opts.surface)) {
    emitSecurityEvent({
      capability: canonical,
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
      capability: canonical,
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
      capability: canonical,
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
          runInTenantScope(
            {
              orgId: ctx.orgId,
              workspaceId: ctx.workspaceId,
              // Principal spine (accountability chain): the originating user
              // and the capability are known at scope entry; the IAM-resolved
              // principal is layered on after the check via runWithPrincipal.
              // Guarded by isUuid — runInTenantScope fail-closes on garbage,
              // and userId can legitimately be null (machine-to-machine).
              userId:
                ctx.userId !== null && isUuid(ctx.userId) ? ctx.userId : null,
              capabilityName: canonical,
            },
            fn,
          )
      : <T>(fn: () => Promise<T>): Promise<T> => fn();

  // ── Audit target (accountability chain) ──────────────────────────────────
  // Derived from the contract's declarative `audit` field: the input field
  // that carries the acted-on object's id. String values only — anything
  // else means the field is absent or the contract mis-declared it, and a
  // null target is safer than a junk one.
  const auditDecl = (
    cap as { audit?: { targetKind: string; targetIdField: string } }
  ).audit;
  let auditTarget: { kind: string; id: string } | null = null;
  if (auditDecl) {
    const targetValue = (inputResult.data as Record<string, unknown>)[
      auditDecl.targetIdField
    ];
    if (typeof targetValue === "string" && targetValue.length > 0) {
      auditTarget = { kind: auditDecl.targetKind, id: targetValue };
    }
  }

  // ── IAM + billing + handler (all inside scope for scoped caps) ───────────
  let output: unknown;
  // The IAM-resolved acting principal — threaded to the handler (CheckedContext)
  // and into the ambient scope (runWithPrincipal) so telemetry writes carry
  // attribution. Null when no IAM runtime is registered or the resolver did
  // not resolve one (non-enterprise tier fast-path).
  let resolvedPrincipal: ResolvedPrincipal | null = null;
  // The platform-created decision reference for THIS invocation. Only ever
  // written from the IAM check's own result — see the strip below.
  let authorizationDecision: AuthorizationDecisionRef | null = null;
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
          capability: canonical,
          ctx,
          defaultEffect,
          rawInputJson,
          target: auditTarget,
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
            capability: canonical,
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

        resolvedPrincipal = iamResult?.principal ?? null;
        authorizationDecision = iamResult?.decision ?? null;

        // Agent-run invocations are ALWAYS enforced, independent of the
        // IAM_ENFORCEMENT_ENABLED rollout flag (Agent RBAC Phase 2, spec
        // §3.4/§3.5): an agent is an unattended automation, and the kernel
        // gate is the defense against prompt-injected direct capability
        // names — a would-deny that proceeds is exactly the poisoned-prompt
        // hole the spec closes. Human/API-key traffic (no ctx.agentRun)
        // keeps the existing flag semantics untouched.
        const isAgentRunInvocation = ctx.agentRun?.principalKind === "agent";

        // ── Agent-run execution fails closed without a decision row ─────────
        // Every governed operation persists one immutable
        // iam.authorization_decisions row. If the IAM runtime could not insert
        // it, the operation is UNRECORDED — and an unrecorded decision is not
        // an allowed one. Deny before the handler runs rather than execute
        // work no audit can ever account for. Human/API traffic is unaffected:
        // it carries no agentRun and persists no decision row.
        if (isAgentRunInvocation && authorizationDecision === null) {
          emitSecurityEvent({
            capability: canonical,
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
            `No authoritative authorization decision could be persisted for "${name}" — ` +
              "agent-run execution fails closed on an unrecorded decision.",
          );
        }

        if (iamResult !== null && iamResult.outcome !== "allow") {
          if (_iamEnforced || isAgentRunInvocation) {
            // Enforcement on: block the call. A "pending_approval" resolution is
            // a soft-deny — the action is DENIED right now, but we mint a JIT
            // access request so an approver can grant it and the caller can poll
            // for status. A hard "deny" mints nothing.
            if (iamResult.outcome === "pending_approval") {
              // Create the access_requests row via the injected creator. This
              // runs inside the active tenant scope (withScope) so the creator's
              // withTenantDb resolves. Creation NEVER changes the decision: a
              // missing creator, a null return, or a thrown creator all still
              // deny — accessRequestId is simply absent (SECURITY INVARIANT).
              let accessRequestId: string | null = null;
              const creator = _accessRequestCreator;
              if (creator !== null) {
                accessRequestId = await creator({
                  capability: canonical,
                  ctx,
                  principal: resolvedPrincipal,
                }).catch((err: unknown) => {
                  console.error(
                    `[kernel] JIT access-request creation failed for "${name}":`,
                    err,
                  );
                  return null;
                });
              }
              emitSecurityEvent({
                capability: canonical,
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
                "pending_approval",
                `IAM requires approval for "${name}" — the action is denied pending approval` +
                  (accessRequestId
                    ? ` (access request ${accessRequestId})`
                    : "") +
                  ".",
                accessRequestId ?? undefined,
                authorizationDecision ?? undefined,
              );
            }
            emitSecurityEvent({
              capability: canonical,
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
              undefined,
              authorizationDecision ?? undefined,
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
      const skipBilling =
        (cap as { noBillingGate?: boolean }).noBillingGate === true;
      if (_billingGate !== null && ctx.orgId && !skipBilling && isScoped) {
        await _billingGate(ctx.orgId);
      }
      // ── End billing admission gate ───────────────────────────────────────────

      // ── Budget admission gate (OXA-1079) ─────────────────────────────────────
      // The hard period-to-date spend ceiling. Fires after the billing gate on
      // exactly the same skip conditions (unscoped / noBillingGate skip it — a
      // read of your own spend/budget must not be blocked by being over budget),
      // and additionally requires a workspaceId (a workspace ceiling can't be
      // evaluated without one). Throws BudgetExceededError (code
      // "budget_exceeded") when a scope's period-to-date spend has reached its
      // ceiling — DENIED before this invocation's own provider cost is incurred.
      if (
        _budgetGate !== null &&
        ctx.orgId &&
        ctx.workspaceId &&
        !skipBilling &&
        isScoped
      ) {
        await _budgetGate({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          capability: canonical,
        });
      }
      // ── End budget admission gate ────────────────────────────────────────────

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
      const claimingPlugin = pluginForContract(canonical);
      if (
        claimingPlugin !== undefined &&
        _entitlementGate !== null &&
        ctx.orgId &&
        ctx.workspaceId
      ) {
        // Entitlement is workspace-scoped: a capability pack installed in one
        // workspace does not entitle sibling workspaces in the same org.
        await _entitlementGate(canonical, ctx.orgId, ctx.workspaceId);
      }
      // ── End capability entitlement gate ─────────────────────────────────────

      const handler = await resolveHandler(canonical);
      // Principal spine: hand the handler the resolved principal
      // (CheckedContext) and enrich the ambient tenant scope so every
      // data-layer write inside the handler — token_usage, tool_invocations,
      // graph mutations — carries "who acted" without per-callsite threading.
      // runWithPrincipal is a passthrough when no scope is active (unscoped
      // capabilities). isUuid guards the fail-closed scope validation.
      const checkedCtx: CheckedContext = {
        ...ctx,
        principal: resolvedPrincipal,
        // Attached ONLY here, only from the IAM runtime's own insert, and only
        // on the allow path — the handler is the one thing downstream of a
        // successful check, so it is the only consumer that can honestly claim
        // "this operation was decided".
        ...(authorizationDecision !== null ? { authorizationDecision } : {}),
        ...(lifecycleExecution
          ? {
              idempotencyKey: lifecycleExecution.idempotencyKey,
              execution: lifecycleExecution,
            }
          : {}),
      };
      const attribution =
        resolvedPrincipal !== null && isUuid(resolvedPrincipal.id)
          ? {
              principalId: resolvedPrincipal.id,
              principalKind: resolvedPrincipal.kind,
            }
          : { principalId: null, principalKind: null };
      return runWithPrincipal(attribution, () =>
        handler(inputResult.data, checkedCtx),
      );
    });
  } catch (err) {
    // Distinguish CapabilityError (handler not found → deny) from a
    // handler runtime throw (→ error). A TenantScopeError (e.g. the MCP
    // orgId:"" fail-open path) carries a stable `code` we surface to the
    // audit chain so the denial reason is explainable (SOC 2 forensics).
    const isCapErr = err instanceof CapabilityError;
    // Duck-typed stable codes from errors the kernel deliberately does NOT
    // import (keeps it free of @oxagen/tenancy / @oxagen/billing deps): a
    // TenantScopeError ("no_tenant_scope") and a BudgetExceededError
    // ("budget_exceeded", OXA-1079). Both are DENIALS, not server errors — a
    // spend-ceiling refusal is a policy decision that belongs in the audit
    // chain as a deny (SOC2), exactly like an IAM deny.
    const duckCode =
      err instanceof Error && "code" in err && err.code === "no_tenant_scope"
        ? ("no_tenant_scope" as const)
        : err instanceof Error &&
            "code" in err &&
            err.code === "budget_exceeded"
          ? ("budget_exceeded" as const)
          : null;
    emitSecurityEvent({
      capability: canonical,
      outcome:
        (isCapErr && err.code === "no_handler") || duckCode ? "deny" : "error",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: isCapErr ? err.code : duckCode,
      durationMs: Date.now() - startMs,
    });
    emitTraceEvent({
      capability: canonical,
      status: "error",
      surface: opts.surface ?? ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      messageId: ctx.messageId,
      input: inputResult.data,
      errorCode: isCapErr ? err.code : (duckCode ?? undefined),
      durationMs: Date.now() - startMs,
    });
    throw err;
  }

  const outputResult = cap.output.safeParse(output);
  if (!outputResult.success) {
    emitSecurityEvent({
      capability: canonical,
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
      capability: canonical,
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
    capability: canonical,
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
    capability: canonical,
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
  /**
   * The platform-created `azd_…` decision reference for this external-tool
   * check. Null when no decision row was persisted — which, for an agent-run
   * caller, is itself a denial (see the fail-closed branch below).
   */
  decision: AuthorizationDecisionRef | null;
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
  // Synthetic external ids (mcp.<server>.<tool>) are never registered, so there
  // is no canonical form to resolve — the raw name IS the identity. Aliasing
  // `canonical` to `name` keeps this function's telemetry blocks identical in
  // shape to kernel.invoke()'s (ADR-022).
  const canonical = name;

  if (checkFn === null) {
    // No IAM runtime registered — unconditionally allow (mirrors kernel.invoke()).
    return { allowed: true, outcome: "allow", reason: null, decision: null };
  }

  let iamCheckThrew = false;
  const iamResult = await checkFn({
    capability: canonical,
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
      capability: canonical,
      outcome: "deny",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: "authz_denied",
      durationMs: Date.now() - startMs,
    });
    return {
      allowed: false,
      outcome: "deny",
      reason: "iam_check_error",
      decision: null,
    };
  }

  const decision = iamResult?.decision ?? null;

  // An agent run's tool boundary is a GOVERNED operation: it persists its own
  // immutable decision row exactly like a kernel invoke(). No row means the
  // operation is unrecorded, and an unrecorded decision is not an allowed one.
  if (ctx.agentRun?.principalKind === "agent" && decision === null) {
    emitSecurityEvent({
      capability: canonical,
      outcome: "deny",
      surface: ctx.surface,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      errorCode: "authz_denied",
      durationMs: Date.now() - startMs,
    });
    return {
      allowed: false,
      outcome: "deny",
      reason: "decision_not_persisted",
      decision: null,
    };
  }

  const outcome = iamResult?.outcome ?? "deny";
  const reason =
    iamResult && "reason" in iamResult ? (iamResult.reason ?? null) : null;
  const isDenied = outcome !== "allow";

  emitSecurityEvent({
    capability: canonical,
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
    // Agent-run checks are always enforced, independent of the rollout flag —
    // same rationale as the matching branch in _invokeCore (Agent RBAC Phase
    // 2, spec §3.4/§3.5): an unattended automation must never proceed on a
    // would-deny.
    if (_iamEnforced || ctx.agentRun?.principalKind === "agent") {
      return { allowed: false, outcome, reason: reason ?? outcome, decision };
    }
    // Enforcement off — log would-deny and allow.
    console.warn(
      `[kernel:external] IAM would-deny "${name}" (outcome=${outcome}, ` +
        `reason=${reason ?? "none"}) — IAM_ENFORCEMENT_ENABLED=false, allowing.`,
    );
    return { allowed: true, outcome, reason: reason ?? outcome, decision };
  }

  return { allowed: true, outcome: "allow", reason: null, decision };
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
