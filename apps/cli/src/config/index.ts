/**
 * @module config — Oxagen Workspace Config: a structured, governed CLAUDE.md
 * replacement (docs/specs/oxagen-workspace-config/design.md).
 *
 * Public surface:
 *   - workspaceConfigSchema / WorkspaceConfig  — the §4 schema, all sections optional
 *   - resolveWorkspaceConfig / explain          — §3 resolution across 4 scopes
 *   - getConfigScopePaths / clearWorkspaceConfigCache
 *   - setPath / addLanguageItem / removeItem / setVision / setVoice /
 *     setWorktreeSeed / writeConsolidated       — §4 scope-aware writers
 *   - buildConsolidatedIndex                    — §5 multi-scope indexer
 */
export {
  workspaceConfigSchema,
  repoRefSchema,
  visionSchema,
  commandEntrySchema,
  commandsSchema,
  worktreeSeedSchema,
  worktreesSchema,
  packageManagersSchema,
  languageVoiceSchema,
  languageItemSchema,
  languageEntrySchema,
  languagesSchema,
  attributionSchema,
  vcsCommitSchema,
  vcsPullRequestSchema,
  vcsBranchSchema,
  vcsSchema,
  linearIssuesConfigSchema,
  githubIssuesConfigSchema,
  issuesSchema,
  databaseSchema,
  sourceCategoriesSchema,
  sourcesSchema,
  consolidatedSkillSchema,
  consolidatedAgentSchema,
  consolidatedMcpServerSchema,
  consolidatedCommandSchema,
  consolidatedCustomToolSchema,
  consolidatedSourceFileSchema,
  consolidatedSchema,
  configScopeSchema,
  CONFIG_SCOPES,
  LANGUAGE_ITEM_KINDS,
  LANGUAGE_ITEM_ORIGINS,
  type WorkspaceConfig,
  type RepoRef,
  type VisionConfig,
  type CommandEntry,
  type CommandsConfig,
  type WorktreeSeed,
  type WorktreesConfig,
  type PackageManagersConfig,
  type LanguageVoice,
  type LanguageItem,
  type LanguageItemKind,
  type LanguageItemOrigin,
  type LanguageEntry,
  type LanguagesConfig,
  type Attribution,
  type VcsConfig,
  type IssuesConfig,
  type DatabaseConfig,
  type SourceCategories,
  type SourcesConfig,
  type ConsolidatedConfig,
  type ConfigScope,
} from "./schema.js";

export {
  resolveWorkspaceConfig,
  explain,
  getConfigScopePaths,
  clearWorkspaceConfigCache,
  mergeWorkspaceConfigs,
  CONFIG_SCOPE_ORDER,
  type ResolvedWorkspaceConfig,
  type WorkspaceConfigScopeFile,
  type ResolveWorkspaceConfigOptions,
  type FieldProvenance,
  type WinReason,
  type ExplainResult,
} from "./resolve.js";

export {
  assertWritableScope,
  writeConfigScopeDoc,
  setValueAtPath,
  setPath,
  addLanguageItem,
  removeItem,
  setVision,
  setVoice,
  setWorktreeSeed,
  writeConsolidated,
  type ConfigWriteCtx,
  type RemoveItemResult,
} from "./write.js";

export { buildConsolidatedIndex, type BuildIndexOptions } from "./indexer.js";
