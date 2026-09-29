// autonomy-allows.ts: whether a scope's autonomy level allows one action now.
//
// Oxagen generates Cedar policies from the [[autonomy]] entries of work.toml,
// one per action, and autonomyAllows evaluates them at the moment Oxagen would
// act, not when the file merged, so a level lowered a minute ago applies to the
// next send. agent-work-spec.html (Autonomy levels) sets what each level allows:
//
// | Level | Name         | Oxagen also                                                          |
// | 0     | Suggest      | Triages, drafts the done record, and plans batches. Nothing more.    |
// | 1     | Send         | Sends placed work orders as the scope's operator (work.send).        |
// | 2     | Merge proven | Merges a proven record whose risk is low or medium (work.merge).     |
// | 3     | Autonomous   | Locks a drafted record that passes lint (work.lock), and closes the  |
// |       |              | source item where the collector's close switch is on (work.close).   |
//
// Level 2 and level 3 never merge high-risk work. The level in force is the lower
// of the file's level and the latest automatic lowering (work.autonomy_events).
import type { DoneVerdict } from "@oxagen/done-record";
import { notBuilt } from "../not-built";
import type { AutonomyLevel, AutonomyScope, RiskLevel, WorkAction } from "../types";

/** The Cedar entity type of the principal: the scope's operator. */
export const AUTONOMY_PRINCIPAL_TYPE = "Oxagen::Operator" as const;

/** The Cedar entity type of every autonomy action. */
export const AUTONOMY_ACTION_TYPE = "Oxagen::Action" as const;

/** The Cedar entity type of the resource. */
export const AUTONOMY_RESOURCE_TYPE = "Oxagen::WorkOrder" as const;

/** What autonomyAllows reads about the work order at the moment Oxagen would act. */
export interface AutonomyFacts {
  /** The scope's operator, whom Oxagen acts as. */
  operator: string;
  /** The level in force: the lower of work.toml's level and the latest automatic lowering. */
  level: AutonomyLevel;
  /** The done record's verdict now. */
  verdict: DoneVerdict;
  /** The pull request's risk. Null before a pull request exists. */
  risk: RiskLevel | null;
  /** True when the drafted done record passes lint. Read for work.lock. */
  lintPassed: boolean;
  /** True when the source item's collector has its close switch on. Read for work.close. */
  closeSwitch: boolean;
  /** What Oxagen spent in the scope today, and the scope's max_daily_usd, when it sets one. */
  spentTodayUsd: number;
  maxDailyUsd?: number;
}

/** Cedar's answer, in the shape @oxagen/tacho's CedarVerdict uses. */
export interface AutonomyDecision {
  decision: "allow" | "deny";
  /** The ids of the policies that decided, sorted. Empty for a deny no policy permitted. */
  reasons: string[];
  /** Why the request could not be decided. A decision with errors is always a deny. */
  errors: string[];
}

/** Decide whether the scope's level allows the action now. */
export function autonomyAllows(scope: AutonomyScope, action: WorkAction, facts: AutonomyFacts): AutonomyDecision {
  return notBuilt("autonomyAllows", scope, action, facts);
}
