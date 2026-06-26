/**
 * @oxagen/mcp-config — File-based MCP server configuration and permissions.
 *
 * Barrel export for the most commonly used APIs. Individual subpath exports
 * are available for tree-shaking:
 *   - @oxagen/mcp-config/schema
 *   - @oxagen/mcp-config/resolve
 *   - @oxagen/mcp-config/credentials
 *   - @oxagen/mcp-config/permissions
 *   - @oxagen/mcp-config/managed
 */

// Schema types and validators
export {
  settingsSchema,
  mcpServerSchema,
  permissionsSchema,
  serverPermissionSchema,
  toolVisibilitySchema,
  managedConfigSchema,
  managedPolicySchema,
  type Settings,
  type McpServerConfig,
  type Permissions,
  type ServerPermission,
  type ToolVisibility,
  type ManagedConfig,
  type ManagedPolicy,
} from "./schema.ts";

// File resolution and merge
export {
  resolveSettings,
  findProjectRoot,
  getSettingsPaths,
  expandEnvVars,
  type ResolveOptions,
  type ResolvedConfig,
  type ResolvedScope,
} from "./resolve.ts";

// Credential management
export {
  resolveCredential,
  readCredential,
  writeCredential,
  deleteCredential,
  persistRefreshedTokens,
  needsRefresh,
  getCredentialFilePath,
  type StoredCredential,
  type ResolvedCredential,
  type ResolveCredentialOptions,
  type RefreshResult,
} from "./credentials.ts";

// Permissions evaluation
export {
  evaluatePermission,
  evaluateServerPermissions,
  filterToolVisibility,
  getNonDeniedTools,
  matchGlob,
  type PermissionDecision,
  type PermissionResult,
  type ToolVisibilityConfig,
} from "./permissions.ts";

// Managed policy enforcement
export {
  loadManagedConfig,
  getManagedConfigPath,
  validateServerAgainstPolicy,
  checkServerUrl,
  checkStdioCommand,
  checkToolDenied,
  getManagedServers,
  isManagedServer,
  formatViolation,
  type PolicyViolation,
} from "./managed.ts";
