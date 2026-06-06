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
   * Client IP for IAM ip_ranges/ip_allow condition evaluation.
   * Optional/nullable — propagated from entry seams (API, MCP, app).
   * When absent, IP-based conditions fail-closed (deny).
   */
  clientIp?: string | null;
}
