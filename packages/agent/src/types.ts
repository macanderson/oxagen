// Mirror of @oxagen/oxagen's CapabilityContext to avoid a static package
// cycle. The shape is structurally identical so handlers in either
// package interop without an adapter.
export interface CapabilityContext {
  tenantId: string;
  workspaceId: string;
  userId: string | null;
  apiKeyId: string | null;
  requestId: string;
  surface: "api" | "mcp" | "app" | "runner";
  messageId: string | null;
}
