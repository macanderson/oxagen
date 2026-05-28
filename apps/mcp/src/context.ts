import type { CapabilityContext } from "@oxagen/oxagen";

// MCP transport will eventually carry tenant + api-key headers; until
// the auth subagent wires them, stub a placeholder context so the
// handler signature stays stable across layers.
export function placeholderContext(): CapabilityContext {
  return {
    tenantId: "00000000-0000-0000-0000-000000000000",
    workspaceId: "00000000-0000-0000-0000-000000000000",
    userId: null,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
  };
}
