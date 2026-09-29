// MCP Studio's public surface (#4678): one page per MCP server inside Tools.
// The Tools route imports from here; nothing else reaches into the folder
// (eslint: `@/features/*/*` is restricted).
export { parseStudioRoute } from "./route";
export { StudioLoading, StudioServer } from "./server-page";
