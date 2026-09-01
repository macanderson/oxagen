// Mirror of @oxagen/oxagen's CapabilityContext to avoid a static package
// cycle. The shape is structurally identical so handlers in either
// package interop without an adapter.
// KEEP IN SYNC with packages/oxagen/src/types.ts CapabilityContext.
//
// `AgentRunIAMContext` and `DeployedAgentInvocationContext` are IMPORTED
// rather than re-mirrored. Both are security types whose whole value is that
// the kernel — and only the kernel — can mint them: `DeployedAgentInvocationContext`
// carries a module-private unique-symbol brand plus a kernel registry entry, so
// a hand-copied structural twin would be a forgery surface, not a mirror. Both
// imports are `import type`, fully erased at emit, so they add NO runtime module
// edge back to @oxagen/oxagen (the cycle this mirror exists to avoid is a runtime
// import cycle; @oxagen/oxagen/iam is the pure, dep-light resolver layer and other
// modules in this package already import @oxagen/oxagen/kernel statically).
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
   * Which run this capability call belongs to — the correlation key the
   * telemetry tables mean by `execution_step_id`, and the field whose absence
   * left `skill_loads.execution_step_id` NULL on every row (#2597).
   *
   * Absent means absent: `undefined` outside a run (API, MCP, a person), and
   * every recorder writes NULL rather than inventing an id. The canonical
   * declaration in packages/oxagen/src/types.ts carries the full reasoning.
   */
  executionStepId?: string | null;
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
   * Present when this capability call originates from a GOVERNED AGENT RUN
   * (Agent RBAC Phase 2, docs/specs/agent-rbac/spec.md §3.4/§3.5): the two
   * principals of the delegation ceiling (agent ∩ initiating human), the
   * run/attempt lineage for audit rows, the pinned admission binding, and the
   * mutable per-run resolution/live-evaluation cache the kernel IAM check and
   * tool materialization BOTH read (one resolution per run — §3.5).
   *
   * Attached by the turn driver for delegated durable runs; absent on every
   * human / API-key / service invocation. The durable-run worker populates it
   * from a claimed v2 run's TYPED columns (see `hydrateAgentRunContext` in
   * ./runtime/turn-driver.ts) — never from the spec JSON alone, and never for
   * a legacy v1 run, which has no principals to bind.
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
