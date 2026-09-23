export * from "./client";
export * as schema from "./schema/index";
// Plugin type discriminator — a named export (not just under the `schema`
// namespace) so the agent runtime + handlers can import the union type directly.
export { PLUGIN_TYPES, type PluginType } from "./schema/plugin";
// cms value sets + types — named exports (not just under `schema`) so the API
// lead-gate routes can import the enums without pulling the whole schema bag.
export {
  BOOK_SLUG,
  EDITION_SLUGS,
  DEFAULT_EDITION_SLUG,
  COMPANY_SIZES,
  REFERRAL_SOURCES,
  CODE_ISSUE_REASONS,
  CODE_STATUSES,
  type EditionSlug,
  type CompanySize,
  type ReferralSource,
  type CodeIssueReason,
  type CodeStatus,
} from "./schema/cms";
export * as relations from "./relations";
export * from "./types";
export {
  withTenantDb,
  withOrgDb,
  withTransactionOrgScope,
  withSystemDb,
  withOrgPlaneSystemDb,
  setTransactionWorkspaceScope,
  assertRlsConnectionSafe,
  assertRlsEnforcedInProduction,
  isOrgOnlyWorkspaceReadRefusal,
  ORG_ONLY_WORKSPACE_GUC,
  type Tx,
} from "./tenant";
export {
  makeWithTenantDbMock,
  makeWithSystemDbMock,
  makeWithOrgDbMock,
} from "./tenant.mock";
// ADR-042 dedicated-plane pool lifecycle. The RESOLVER itself is not re-exported
// here on purpose: data-plane-resolver.ts imports `schema` from this barrel, so
// pulling it into the barrel would make the module graph cyclic. Import it from
// the "@oxagen/database/data-plane" subpath instead — the same shape as
// "@oxagen/database/security".
export {
  closeDedicatedPools,
  dedicatedPoolCount,
  evictOrg as evictDedicatedPlanePools,
  MAX_DEDICATED_POOLS,
} from "./data-plane-pool";
export { recordIfUnscoped, __unscopedCountForTests } from "./unscoped-meter";
export { isUniqueViolation } from "./errors";
export {
  readRunVerdict,
  readWitnessedRunId,
  hidesWitnessRuns,
  notWitnessRun,
} from "./proof";
export { agentCreatorUserJoin, operatorUserJoin } from "./relations";
export {
  deriveNamespace,
  normalizeNamespaceSeed,
  NAMESPACE_PATTERN,
  NAMESPACE_MIN_LENGTH,
  NAMESPACE_MAX_LENGTH,
} from "./namespace";
export {
  hasColumn,
  hasColumnFresh,
  ambientPlaneKey,
  runOnPlane,
  resetColumnProbesForTests,
  NEGATIVE_PROBE_TTL_MS,
  type ColumnRef,
  type ProbeTx,
} from "./column-probe";
export { CONTEXT_VERSION_CLASSIFICATION_COLUMN } from "./schema/agent";
export {
  CONTAINED_LAUNCH_COLUMN,
  GATEWAY_CHAIN_COLUMN,
  HOST_GATEWAY_COLUMN,
  HOST_MODEL_BASE_URLS_COLUMN,
  SESSION_FILE_OBSERVED_STATUS_COLUMN,
  SESSION_GATEWAY_COLUMN,
  SESSION_PUSHES_COLUMN,
  SESSION_MACHINE_SNAPSHOT_COLUMN,
} from "./schema/tacho";
export { TACHO_SESSION_POLICY_COLUMN } from "./schema/workspace";
