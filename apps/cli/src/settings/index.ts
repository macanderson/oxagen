/**
 * @module settings — The unified `settings.json` driver for the Oxagen CLI.
 *
 * One hierarchical settings file (user → project → local) configures the CLI's
 * model, environment, platform URL, tool permissions, and lifecycle hooks —
 * the spine the MCP-client, agents, commands, and skills subsystems plug into.
 *
 * Public surface:
 *   - loadSettings / getScopePaths / clearSettingsCache  — resolution
 *   - applySettingsToEnv                                 — startup projection
 *   - wrapToolsWithGate                                  — permission + hook gate
 *   - runHooks                                           — lifecycle hook engine
 *   - writeSettingsValue / writeStarterSettings          — `oxagen settings` writes
 */
export {
  oxagenSettingsSchema,
  permissionsSchema,
  hooksSchema,
  HOOK_EVENTS,
  type OxagenSettings,
  type Permissions,
  type PermissionMode,
  type Hooks,
  type HookMatcher,
  type HookAction,
  type HookEvent,
} from "./schema.js";

export {
  loadSettings,
  getScopePaths,
  clearSettingsCache,
  type ResolvedSettings,
  type ResolvedScopeFile,
  type ResolveSettingsOptions,
  type SettingsScope,
} from "./resolve.js";

export { applySettingsToEnv, type AppliedSettingsEnv } from "./runtime.js";

export { wrapToolsWithGate, type ToolGateContext } from "./gate.js";

export { runHooks, type HookPayload, type HookRunOutcome } from "./hooks.js";

export {
  evaluateLocalPermission,
  parseRule,
  type LocalPermissionResult,
} from "./permissions-gate.js";

export {
  writeSettingsValue,
  writeStarterSettings,
  readScopeDoc,
  writeScopeDoc,
  SETTABLE_KEYS,
  type WriteValueOptions,
  type InitOptions,
} from "./write.js";

export {
  writeMcpServer,
  removeMcpServer,
  setMcpServerDisabled,
  findServerScope,
  type WriteMcpServerOptions,
  type McpMutateOptions,
} from "./mcp-write.js";
