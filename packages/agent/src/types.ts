// Mirror of @oxagen/oxagen's CapabilityContext to avoid a static package
// cycle. The shape is structurally identical so handlers in either
// package interop without an adapter.
// KEEP IN SYNC with packages/oxagen/src/types.ts CapabilityContext.
//
// The `agentRun` slot uses a type-only import from @oxagen/oxagen/iam — fully
// erased at emit, so it adds NO runtime module edge (the cycle this mirror
// exists to avoid is a runtime import cycle; @oxagen/oxagen/iam is the pure,
// dep-light resolver layer and other modules in this package already import
// @oxagen/oxagen/kernel statically).
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
   * Present when this capability call originates from an AGENT RUN (Agent
   * RBAC Phase 2, docs/specs/agent-rbac/spec.md §3.4/§3.5): the two
   * principals of the delegation ceiling (agent ∩ invoking human), run
   * lineage for audit rows, and the mutable per-run resolution cache the
   * kernel IAM check and tool materialization BOTH read (one resolution per
   * run — §3.5). Attached by the turn driver
   * (packages/agent/src/runtime/turn-driver.ts) for delegated durable runs;
   * absent on every human / API-key / service invocation.
   */
  agentRun?: AgentRunIAMContext;
}
