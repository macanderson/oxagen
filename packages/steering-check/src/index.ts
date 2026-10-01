// @oxagen/steering-check: the checks a steering PR runs, as one pure package
// the server and the CLI share. It does no I/O. The caller passes the files,
// the published index, and what Oxagen knows outside the repository.
export type {
  CedarHooks,
  CedarIssue,
  CheckContext,
  CheckInput,
  CheckReport,
  CheckResult,
  CheckStatus,
  Finding,
  IndexRecord,
  ServerFileOutcome,
  ServerReaders,
  SettingsDifferenceInput,
  Severity,
  SteeringCheckName,
  SteeringTree,
} from "./types";
export { runChecks, STEERING_CHECK_NAMES } from "./run";
export { findingPlace, formatHuman, formatJson } from "./format";
export { findSecretsAndPii } from "./secrets";
export { settingsDifferences } from "./settings-diff";
export { alwaysOnBlocks, type AlwaysOnBlock, type AlwaysOnEntry } from "./always-on";
export { alwaysOnBudget, definitionBudget, directDefinitions, type ServerDefinitions } from "./checks/budget";
export { closest } from "./checks/references";
export {
  NEAR_DUPLICATE_MIN_WORDS,
  NEAR_DUPLICATE_SIMILARITY,
  similarStatements,
  type ComparedStatement,
  type StatementMatch,
} from "./checks/conflicts";
export {
  markImportMatches,
  type ImportMatch,
  type ImportMatchRow,
  type ImportPublishedRecord,
} from "./import-matches";
