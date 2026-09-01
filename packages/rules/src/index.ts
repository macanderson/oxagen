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
export {
  createDecisionRulesGate,
  DecisionRuleApprovalRequiredError,
  DecisionRuleDeniedError,
  type DecisionGateArgs,
  type DecisionRulesGateFn,
  type DecisionRulesGateOptions,
  type RuleSetLoader,
} from "./gate";
export {
  bootstrapDecisionRulesRuntime,
  clearDecisionRulesCache,
  loadWorkspaceRuleSet,
} from "./bootstrap";
