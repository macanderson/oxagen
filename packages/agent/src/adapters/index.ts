// Postgres lease-backed file lock (ADR-021 §5) — the current provider.
export { createFileLeaseLockAdapter } from "./file-lock-lease";
export type { FileLeaseLockAdapterArgs } from "./file-lock-lease";
export { createPlatformAgentAi } from "./platform-agent-ai";
export {
  ModalSandboxWorkspace,
  SandboxWorkspaceUnavailableError,
} from "./sandbox-workspace";
export type {
  ModalSandboxWorkspaceOptions,
  SandboxRepoSpec,
} from "./sandbox-workspace";
// Re-exported so surfaces (e.g. apps/app) can gate code-mode on a configured
// sandbox driver without taking a direct @oxagen/sandbox dependency.
export { isSandboxAvailable } from "@oxagen/sandbox";
