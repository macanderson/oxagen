export * from "./client";
export * as schema from "./schema/index";
// Plugin type discriminator — a named export (not just under the `schema`
// namespace) so the agent runtime + handlers can import the union type directly.
export { PLUGIN_TYPES, type PluginType } from "./schema/plugin";
// cms value sets + types — named exports (not just under `schema`) so the API
// routes, seed, and web-facing validation can import the ebook-gate constants
// directly.
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
  withSystemDb,
  assertRlsConnectionSafe,
  assertRlsEnforcedInProduction,
  type Tx,
} from "./tenant";
export { makeWithTenantDbMock, makeWithSystemDbMock } from "./tenant.mock";
export { recordIfUnscoped, __unscopedCountForTests } from "./unscoped-meter";
export { isUniqueViolation } from "./errors";
export {
  deriveNamespace,
  normalizeNamespaceSeed,
  NAMESPACE_PATTERN,
  NAMESPACE_MIN_LENGTH,
  NAMESPACE_MAX_LENGTH,
} from "./namespace";
