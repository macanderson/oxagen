import type { z } from "zod";

export type ExecutionMode = "sync" | "async" | "batch";

// ── IAM role types ────────────────────────────────────────────────────────────

/** Effect of a grant or role-grant entry. */
export type GrantEffect = "allow" | "deny" | "require_approval";

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
  | "marketing";

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
   * Default role-based grants for this capability. Optional — absence means
   * the capability inherits no default grants and relies on explicit grants.
   * Added in Phase 2 (OXA-1389); required by the defineContract helper in
   * Phase 3 (OXA-1390).
   *
   * `org` grants apply when the scope is org-level.
   * `workspace` grants apply when the scope is workspace-level.
   */
  defaultRoles?: {
    org?: Partial<Record<SystemOrgRole, GrantEffect>>;
    workspace?: Partial<Record<SystemWorkspaceRole, GrantEffect>>;
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
