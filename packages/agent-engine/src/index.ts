export * from "./types";
export * from "./ports";
export { MemoryWorkspace } from "./workspaces/memory";
export { buildWorkspaceTools } from "./tools";
// LocalWorkspace is a CLI adapter (Stage B), not engine code — see ADR-019.
export { runCodingAgent, changedFilesFromDiff } from "./engine";
