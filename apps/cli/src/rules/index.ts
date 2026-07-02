/**
 * @module rules — Workspace rules the agent retrieves, is told about, and is
 * hard-blocked from violating. The CLI-local foundation of the adherence loop
 * in docs/specs/stella-graph-memory-sync/spec.md (§4), including the
 * memory→rule promotion path (§3.2, Phase 4) in `promote.ts`.
 */
export type { Rule, RuleGuard } from "./types.js";
export { loadRules, type LoadRulesOptions } from "./loader.js";
export {
  renderRulesSection,
  guardsToDeny,
  guardDenyEntry,
  type RuleDenies,
} from "./enforce.js";
export { scaffoldRule } from "./write.js";
export {
  mineCandidates,
  promoteCandidate,
  type MineInput,
  type MineConfig,
  type RuleCandidate,
  type RuleEvidence,
  type PromoteOptions,
  type PromoteResult,
} from "./promote.js";
