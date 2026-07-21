// Mirror of @oxagen/oxagen's CapabilityContext to avoid a static package
// cycle. The shape is structurally identical so handlers in either
// package interop without an adapter.
// KEEP IN SYNC with packages/oxagen/src/types.ts CapabilityContext.
export interface CapabilityContext {
  orgId: string;
  workspaceId: string;
  userId: string | null;
  apiKeyId: string | null;
  requestId: string;
  surface: "api" | "mcp" | "app" | "runner";
  messageId: string | null;
  /**
   * The org's effective subscription tier. Optional — populated during
   * org-scope resolution. Handlers that gate features must read this or
   * call `resolveOrgTier(ctx.orgId)` directly.
   */
  planTier?: "free" | "build" | "scale" | "enterprise";
  /**
   * Client IP for IAM ip_ranges/ip_allow condition evaluation.
   * Optional/nullable — propagated from entry seams (API, MCP, app).
   * When absent, IP-based conditions fail-closed (deny).
   */
  clientIp?: string | null;
  /**
   * Discriminates who is acting: 'human' for a direct human request, 'agent'
   * for a deployed agent run. Undefined ≡ 'human' for enforcement purposes.
   * docs/specs/agent-rbac/spec.md §3.1/§3.4 — see the oxagen package's
   * CapabilityContext for the full rationale. Set via
   * `buildAgentRunContext` (packages/oxagen/src/types.ts), never hand-rolled.
   */
  principalKind?: "human" | "agent";
  /**
   * The AGENT principal (iam.principals kind='agent') driving this run, when
   * principalKind='agent'. Never minted per-invocation — always the agent's
   * one persistent identity principal (agents.principalId).
   */
  agentPrincipal?: {
    id: string;
    kind: "human" | "agent" | "service";
    orgId: string;
    workspaceId: string | null;
  } | null;
  /**
   * The invoking HUMAN principal an agent run acts on behalf of. Populated
   * whenever principalKind='agent'; undefined for direct human invocations.
   */
  humanPrincipal?: {
    id: string;
    kind: "human" | "agent" | "service";
    orgId: string;
    workspaceId: string | null;
  } | null;
}
