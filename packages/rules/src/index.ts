/**
 * @oxagen/rules — the workspace decision-rules engine.
 *
 * Governs which business actions an agent may take on its own (a refund, a
 * customer message) at the one place every action already passes: the kernel's
 * `invoke()` gate chain. Pure evaluation over declared rules and
 * caller-resolved facts; typed verdicts; fails open on its own infrastructure
 * and never on a computed verdict. See src/types.ts for the design.
 */
export {
  CONDITION_OPS,
  type Condition,
  type ConditionLeaf,
  type ConditionOp,
  type DecisionRule,
  type DecisionSubject,
  type FactResolver,
  type RuleEffect,
  type RuleSet,
  type Verdict,
} from "./types";
export {
  capabilityMatches,
  evaluateCondition,
  evaluateRules,
  requiredFactKeys,
} from "./evaluate";
export { parseRuleSet, ruleSetSchema } from "./schema";
// The auto-approval clause of the same rule set (ADR-070): the pure evaluator
// the decision path runs, the reason vocabulary the app maps to copy, and the
// floor test a recorded result is read back through.
export {
  evaluateAutoApproval,
  isFloorReason,
  withinBusinessHours,
  HARD_FLOOR_REASONS,
  IRREVERSIBLE_CONSEQUENCE_TAGS,
  REASON,
  type AutoApprovalOutcome,
  type AutoApprovalSubject,
} from "./auto-approval";
export { autoApproveParkedCall } from "./auto-approval-path";
export {
  buildAutoApprovalSubject,
  inputDigest,
  lastHumanApprovalOf,
  loadDeclaredTool,
  readDeclaredMeasures,
  type DeclaredTool,
} from "./call-facts";
export { loadRuleSetIn, lockDecisionRulesIn } from "./rule-store";
export {
  createDecisionRulesGate,
  DecisionRuleApprovalRequiredError,
  DecisionRuleDeniedError,
  type DecisionGateArgs,
  type DecisionRulesGateFn,
  type DecisionRulesGateOptions,
  type RuleSetLoader,
} from "./gate";
// The mandate ledger as the handlers, the approval hop and the expiry job
// use it; the decision-time check reaches the kernel through bootstrap.
export {
  expireApproval,
  hasDrawnInCurrentPeriod,
  hasOpenReservation,
  hasSettlementOverlappingPeriod,
  hasUnstampedLedgerHistory,
  lastLedgerKind,
  lockMandate,
  parseMandateRow,
  readAuthority,
  release,
  releaseParked,
  type MandateRecord,
} from "./mandates";
export {
  legacyMeasureKindGuess,
  measureKindOf,
  periodKey,
  periodKeyRange,
  periodKeysOverlap,
  toolMatches,
} from "./mandates/measures";
export {
  bootstrapDecisionRulesRuntime,
  clearDecisionRulesCache,
  loadWorkspaceRuleSet,
} from "./bootstrap";
// The `approval.requested` fan-out — shared by every writer of an approval
// row — is deliberately NOT re-exported here. It ships on its own subpath,
// `@oxagen/rules/approval-notify`, so a consumer takes the module without the
// mandate ledger behind this barrel, and so there is exactly one specifier
// for it. Two paths to one module is how a test that stubs the barrel ends up
// stubbing a control it meant to exercise.
