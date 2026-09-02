import type { CapabilityContext } from "@oxagen/oxagen";

export const TEST_CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

export function makeCTX(
  overrides: Partial<CapabilityContext> = {},
): CapabilityContext {
  return { ...TEST_CTX, ...overrides };
}
