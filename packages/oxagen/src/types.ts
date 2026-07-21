import type { z } from "zod";
import type { LifecycleEvent } from "@oxagen/agent-artifacts";

export type ExecutionMode = "sync" | "async" | "batch";

// ── IAM role types ────────────────────────────────────────────────────────────

/** Effect of a grant or role-grant entry. */
export type GrantEffect = "allow" | "deny" | "require_approval";

/**
 * Sensitivity classification for a capability. Drives default-deny policies
 * and audit-event sensitivity tagging.
 * - low: read-only, no PII, reversible.
 * - medium: writes or reads PII/billing data, reversible.
 * - high: irreversible writes or access to sensitive credentials.
 * - destructive: permanently deletes data or terminates resources.
 */
export type CapabilitySensitivity = "low" | "medium" | "high" | "destructive";

/**
 * Default IAM effect when no explicit grant/role/policy matches.
 * Every contract must declare this — the resolver uses it as rule 8.
 */
export type CapabilityEffect = "allow" | "deny" | "require_approval";

// DenialResponse — returned by kernel.invoke() when the IAM resolver decides
// deny or pending_approval. isDenial() narrows the union so callers can handle
// allow vs deny cleanly.

export interface DenialResponse {
  /** Sentinel discriminant — always true on a DenialResponse. */
  readonly __capabilityDenied: true;
  readonly outcome: "deny" | "pending_approval";
  /** Machine-readable reason code from the resolver. */
  readonly reason: string;
  /**
   * Present when outcome is 'pending_approval'. Points to the
   * org.access_requests row that was created for this invocation.
   */
  readonly requestId?: string;
}

/** Type guard — true if the value is a DenialResponse. */
export function isDenial(value: unknown): value is DenialResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["__capabilityDenied"] === true
  );
}

/** System-defined org-level roles that exist in every org. */
export type SystemOrgRole = "Owner" | "Admin" | "Compliance" | "Billing";

/** System-defined workspace-level roles that exist in every workspace. */
export type SystemWorkspaceRole = "Owner" | "Member" | "Viewer";

export type CapabilityLayer =
  | "schema"
  | "api"
  | "mcp"
  | "unit"
  | "e2e"
  | "docs"
  // "app" — the capability is meant to be operable by a human in the Next.js
  // app (apps/app). Declaring it is a BINDING PROMISE that a real, working UI
  // invokes this capability. It is satisfied only when the capability has an
  // entry in apps/app/capability-ui-map.json pointing at a page file that
  // exists AND renders without an error page (proven by screenshot/e2e). See
  // the "UI Capability Parity" law: tools/scripts/check_ui_parity.mjs enforces
  // both directions (declared-app must be wired; app-invoked must declare app).
  | "app";

// Where a capability is exposed. A capability with `surfaces: ['agent']`
// is invoked only by the in-app agent mid-stream and skips the /v1
// HTTP layer + MCP wrapping. Default is the public-facing pair.
export type CapabilitySurface = "api" | "mcp" | "agent" | "cli";

export type RiskLevel = "low" | "medium" | "high";

// Agent-surface metadata. Read by the chat runtime to decide approval
// flow, allowlist gating, and risk-badge rendering. Ignored when the
// `agent` surface is absent.
export interface CapabilityAgentMetadata {
  requiresApproval?: boolean;
  riskLevel?: RiskLevel;
  category?: string;
}

export interface CapabilityLifecycleMetadata {
  allowedEvents: readonly LifecycleEvent[];
  effect: "read" | "mutation";
  idempotency: "none" | "supported" | "required";
  outputKinds: readonly ("opaque" | "prompt_patch" | "decision")[];
}

export interface LifecycleExecutionContext {
  kind: "lifecycle";
  event: LifecycleEvent;
  invocationId: string;
  depth: number;
  idempotencyKey: string;
}

// ── Capability presentation + chaining metadata (generic capability engine) ───
//
// These optional, FULLY-SERIALIZABLE descriptors let the chat layer render every
// capability's output as a typed React component (never raw JSON) and let the
// composition planner discover valid capability chains. They carry NO functions,
// so they survive the registry signature (registry.ts → JSON.stringify) and the
// JSON manifest unchanged. The controlled vocabularies, route registry, and the
// resolution precedence all live in capability-meta.ts; only the shapes live
// here so a contract can declare them inline where it reads naturally.

/**
 * A semantic data tag naming a kind of value that flows between capabilities.
 * The composition planner matches one capability's `produces` tags against
 * another's `consumes` tags to discover valid output→input chains. The
 * controlled vocabulary (e.g. "graph.nodeId", "document.text", "asset.id") is
 * documented in capability-meta.ts (CAPABILITY_DATA_TAGS).
 */
export type CapabilityDataTag = string;

/**
 * Declarative spec for turning a record-id field in a capability's output into a
 * deep link to its detail page. Serializable (no functions) so it survives the
 * registry signature + JSON manifest. `recordType` keys the route registry in
 * capability-meta.ts (RECORD_LINK_ROUTES).
 */
export interface RecordLinkSpec {
  /** Dot-path into the output object holding the record id (e.g. "nodeId"). */
  field: string;
  /** Record kind — keys RECORD_LINK_ROUTES (e.g. "graph.node", "conversation"). */
  recordType: string;
  /** Optional dot-path to a human label for the link text. */
  labelField?: string;
}

/**
 * Render hint for a capability's output. The chat layer resolves an effective
 * render directive by precedence:
 *   1. an explicit `render` directive embedded in the OUTPUT VALUE
 *      (the archive.create pattern — flat, component-specific props), then
 *   2. this contract-level hint (or the curated table in capability-meta.ts),
 *      rendered through the uniform result envelope, then
 *   3. the generic `capability-result` fallback with heuristic record links.
 * Serializable — no functions.
 */
export interface CapabilityRenderHint {
  /** Registered chat component id to render the output with. */
  componentId: string;
  /** Record-id fields in the output that deep-link to detail pages. */
  recordLinks?: readonly RecordLinkSpec[];
  /** Output fields to omit from a generic key/value render (noise/internal). */
  hideFields?: readonly string[];
  /** Dot-path to the field whose value titles the result card. */
  titleField?: string;
}

export interface CapabilityDeclaration<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  domain: string;
  description: string;
  mode: ExecutionMode;
  surfaces?: readonly CapabilitySurface[];
  layers: readonly CapabilityLayer[];
  agent?: CapabilityAgentMetadata;
  /** Explicit opt-in for deterministic out-of-model lifecycle execution. */
  lifecycle?: CapabilityLifecycleMetadata;
  input: TInput;
  output: TOutput;
  /**
   * When true, the route + tool resolve a workspace from the request context
   * and enforce tenant-scoped queries. Capability handlers receive the
   * resolved scope. Default true.
   */
  scoped?: boolean;
  /**
   * When true, the billing admission gate is skipped for this capability.
   * Use for management/admin capabilities that do not consume AI tokens
   * (API key creation, member management, settings reads, etc.).
   * Default false — AI/agent capabilities that consume credits should leave
   * this unset so the gate refuses calls from orgs with zero balance.
   */
  noBillingGate?: boolean;
  /**
   * Sensitivity classification for this capability. Required — the IAM
   * resolver uses it for logging and the seed migration uses it for default
   * role-grant decisions.
   */
  sensitivity: CapabilitySensitivity;
  /**
   * The IAM resolver's rule-8 fallback: what happens when no explicit
   * grant/role/policy matches. Required.
   *
   * For most read-only capabilities this is 'deny' (default-deny is the
   * secure baseline); explicitly grant access to principals that need it.
   * Use 'require_approval' to enforce JIT access for elevated actions.
   */
  defaultEffect: CapabilityEffect;
  /**
   * Default role-based grants for this capability. Required — absence means
   * the capability inherits no default grants and relies on explicit grants.
   *
   * `org` grants apply when the scope is org-level.
   * `workspace` grants apply when the scope is workspace-level.
   */
  defaultRoles: {
    org: Partial<Record<SystemOrgRole, GrantEffect>>;
    workspace: Partial<Record<SystemWorkspaceRole, GrantEffect>>;
  };
  /**
   * Declarative audit-target extraction (accountability chain). When set,
   * the kernel reads `input[targetIdField]` (string values only) from the
   * validated input and threads `{ kind: targetKind, id: value }` into the
   * IAM audit row's `target_kind`/`target_id` — making "who touched object X"
   * a queryable fact instead of a null column. Opt-in per contract because
   * only the contract author knows which input field is the acted-on object
   * (a heuristic would mislabel ids). Serializable — no functions.
   */
  audit?: {
    /** What the target is, e.g. "graph.node", "skill", "repo". */
    targetKind: string;
    /** Input field carrying the target's id, e.g. "nodeId". */
    targetIdField: string;
  };
  /**
   * Optional chat-render hint for this capability's OUTPUT. Absent → the chat
   * layer falls back to the generic `capability-result` component. Resolution
   * precedence lives in capability-meta.ts (resolveRenderDirective).
   */
  render?: CapabilityRenderHint;
  /**
   * Semantic data tags this capability's OUTPUT yields, for the composition
   * planner. e.g. graph.node.upsert produces ["graph.nodeId"].
   */
  produces?: readonly CapabilityDataTag[];
  /**
   * Semantic data tags this capability's INPUT requires, for the composition
   * planner. e.g. graph.edge.upsert consumes ["graph.nodeId"].
   */
  consumes?: readonly CapabilityDataTag[];
  /**
   * Capability names that commonly run after this one — a soft hint the planner
   * and the in-chat agent use to suggest the next step in a chain.
   */
  chainHints?: readonly string[];
}

export const DEFAULT_SURFACES: readonly CapabilitySurface[] = ["api", "mcp"];

export function getSurfaces(
  cap: Pick<CapabilityDeclaration, "surfaces">,
): readonly CapabilitySurface[] {
  return cap.surfaces ?? DEFAULT_SURFACES;
}

/**
 * Handlers receive CheckedContext — CapabilityContext plus the IAM-resolved
 * principal (null when the resolver did not run, e.g. the non-enterprise
 * tier fast-path). Implementations that only need CapabilityContext remain
 * assignable (param contravariance) — the principal is opt-in to read.
 */
export type CapabilityHandler<C extends CapabilityDeclaration> = (
  input: z.infer<C["input"]>,
  ctx: CheckedContext,
) => Promise<z.infer<C["output"]>>;

/**
 * Subscription tier for the org that owns this request.
 * Optional — populated by org-scope resolution in the API/MCP middleware once
 * the billing tables are available. Absent on internal service calls that
 * bypass the middleware chain. Use `resolveOrgTier` to fetch it explicitly
 * when gating features inside a handler.
 */
export type PlanTier = "free" | "build" | "scale" | "enterprise";

export interface CapabilityContext {
  orgId: string;
  workspaceId: string;
  userId: string | null;
  apiKeyId: string | null;
  requestId: string;
  /** Surface the request originated from — propagated into telemetry. */
  surface: "api" | "mcp" | "app" | "runner";
  /**
   * Present when the capability is invoked mid-chat by the in-app agent.
   * Used by the approval gate to attach the request to the message DAG.
   * Null for direct API / MCP calls.
   */
  messageId: string | null;
  /**
   * The org's effective subscription tier. Optional — populated during
   * org-scope resolution. Handlers that gate features must read this or
   * call `resolveOrgTier(ctx.orgId)` directly.
   */
  planTier?: PlanTier;
  /**
   * Client IP address for the request. Optional (nullable) — extracted from
   * x-forwarded-for (first hop) or x-real-ip at each surface entry seam and
   * propagated into the IAM resolver for ip_ranges / ip_allow condition
   * evaluation. When null/absent, any IP-based condition fails-closed (deny).
   *
   * Never use this field as a security boundary for anything other than IAM
   * condition evaluation — IP addresses can be spoofed via proxy headers.
   * The IAM layer is the enforcing surface.
   */
  clientIp?: string | null;
}

/**
 * Resolved principal identity — populated by the IAM layer after validating
 * the request session. Null when the IAM tables are not yet applied (graceful
 * degradation) or when the surface does not carry a session (e.g. an internal
 * service call with only an apiKeyId).
 */
export interface ResolvedPrincipal {
  id: string;
  kind: "human" | "agent" | "service";
  orgId: string;
  workspaceId: string | null;
}

/**
 * The context passed to the handler after the IAM resolver decides 'allow'.
 * Extends CapabilityContext with the resolved principal so handlers can
 * record authoring metadata without re-querying the DB.
 */
export interface CheckedContext extends CapabilityContext {
  /**
   * Resolved IAM principal for this invocation. Null when the resolver ran
   * but found no principal (non-enterprise tier fast-path, IAM tables not
   * applied — graceful degradation to defaultEffect). Optional so that a
   * plain CapabilityContext remains assignable (absent ≡ null): the kernel
   * ALWAYS supplies the field on the real invocation path; handlers read it
   * as `ctx.principal ?? null` and must treat null/absent identically.
   */
  principal?: ResolvedPrincipal | null;
  /** Stable logical-invocation key; never injected into strict handler input. */
  idempotencyKey?: string;
  /** Present only when the kernel is executing a lifecycle invocation. */
  execution?: LifecycleExecutionContext;
}

export interface CapabilityManifestEntry {
  name: string;
  file: string;
  domain: string;
  mode: ExecutionMode;
  surfaces: readonly CapabilitySurface[];
  layers: Record<CapabilityLayer, boolean>;
}

export interface CapabilityManifest {
  generatedAt: string;
  capabilities: CapabilityManifestEntry[];
}
