// Mirror of @oxagen/oxagen's CapabilityContext to avoid a static package
// cycle. The shape is structurally identical so handlers in either
// package interop without an adapter.
// KEEP IN SYNC with packages/oxagen/src/types.ts CapabilityContext.
//
// `AgentRunIAMContext` and `DeployedAgentInvocationContext` are IMPORTED
// rather than re-mirrored. Both are security types whose whole value is that
// the kernel — and only the kernel — can mint them: `DeployedAgentInvocationContext`
// carries a module-private unique-symbol brand plus a kernel registry entry, so
// a hand-copied structural twin would be a forgery surface, not a mirror. The
// import is `import type`, which erases at compile time, so it adds no runtime
// edge back to @oxagen/oxagen and the no-cycle property above still holds.
import type { DeployedAgentInvocationContext } from "@oxagen/oxagen";
import type { AgentRunIAMContext } from "@oxagen/oxagen/iam";

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
   * Present when this capability call originates from a GOVERNED AGENT RUN.
   * Carries the two principals of the delegation ceiling (agent ∩ initiating
   * human), the run/attempt lineage for audit rows, the pinned admission
   * binding, and the per-run live-evaluation cache.
   *
   * The durable-run worker populates it from a claimed v2 run's TYPED columns
   * (see `hydrateAgentRunContext` in ./runtime/turn-driver.ts) — never from
   * the spec JSON alone, and never for a legacy v1 run, which has no
   * principals to bind.
   */
  agentRun?: AgentRunIAMContext;
  /**
   * Present ONLY on pre-run agent surfaces that must act as a deployed agent
   * before any run exists — most importantly governed run admission. The
   * kernel creates it and records it in a module-private registry; a forged
   * or replayed object fails that check and is treated as absent.
   */
  deployedAgentInvocation?: DeployedAgentInvocationContext;
}
