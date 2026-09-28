// The Tools page's public surface (mockup `tools.md`). The route imports from
// here; nothing else reaches into the folder (eslint: `@/features/*/*` is
// restricted).
export { Tools, ToolsLoading } from "./tools";
export { parseToolsTab } from "./view";
export { handleMcpOAuthCallback } from "./oauth-callback";
// The pieces a Studio server page (`@/features/mcp-studio`) reuses, so a
// server and its tools are turned off, and a failed read is drawn, the way
// the Tools page does it.
export { FlipControls } from "./switch-controls";
export { Actor as SwitchActor } from "./switches";
export { ToolsReadFailure } from "./read-failure";
