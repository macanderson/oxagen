/**
 * @module rules — Workspace rules the agent retrieves, is told about, and is
 * hard-blocked from violating. The CLI-local foundation of the adherence loop
 * in docs/specs/stella-graph-memory-sync/spec.md (§4).
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
