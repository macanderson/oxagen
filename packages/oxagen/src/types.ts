import type { z } from "zod";

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

// DenialResponse — returned by defineContract().invoke() when the IAM resolver
// decides deny or pending_approval. Guards never expose the raw handler.
// isDenial() narrows the union so callers can handle allow vs deny cleanly.

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
  | "docs";

// Where a capability is exposed. A capability with `surfaces: ['agent']`
// is invoked only by the in-app agent mid-stream and skips the /v1
// HTTP layer + MCP wrapping. Default is the public-facing pair.
export type CapabilitySurface = "api" | "mcp" | "agent";

export type RiskLevel = "low" | "medium" | "high";

// Agent-surface metadata. Read by the chat runtime to decide approval
// flow, allowlist gating, and risk-badge rendering. Ignored when the
// `agent` surface is absent.
export interface CapabilityAgentMetadata {
  requiresApproval?: boolean;
  riskLevel?: RiskLevel;
  category?: string;
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
  input: TInput;
  output: TOutput;
  /**
   * When true, the route + tool resolve a workspace from the request context
   * and enforce tenant-scoped queries. Capability handlers receive the
   * resolved scope. Default true.
   */
  scoped?: boolean;
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
}

export const DEFAULT_SURFACES: readonly CapabilitySurface[] = ["api", "mcp"];

export function getSurfaces(
  cap: Pick<CapabilityDeclaration, "surfaces">,
): readonly CapabilitySurface[] {
  return cap.surfaces ?? DEFAULT_SURFACES;
}

export type CapabilityHandler<C extends CapabilityDeclaration> = (
  input: z.infer<C["input"]>,
  ctx: CapabilityContext,
) => Promise<z.infer<C["output"]>>;

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
   * Resolved IAM principal for this invocation. Null when the IAM tables
   * have not been applied yet (graceful degradation to defaultEffect).
   */
  principal: ResolvedPrincipal | null;
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
