/**
 * Shared domain types for the agent fleet — re-exported from
 * `@oxagen/agent-engine`.
 *
 * A *plan* decomposes a goal into *tasks*. A task is assigned to a subagent,
 * which runs the ONE engine loop against the working tree. The fleet
 * orchestrates many of these at once under a concurrency cap, records what each
 * one built/fixed as memory, and feeds the agents screen its live roster.
 *
 * `@oxagen/agent-engine` owns the task/plan/snapshot/usage shapes: the engine's
 * own `Fleet` orchestrator and this CLI build the same `Task`/`Plan` objects,
 * so there is exactly one definition and no copy to drift. This module
 * re-exports them so every `fleet/types.js` import in the CLI resolves.
 *
 * `AgentDefinition` is deliberately NOT re-exported — the CLI has its own
 * richer definition at `apps/cli/src/agents/types.ts` and forwarding the
 * engine's here would shadow it. Import that one directly.
 *
 * The fleet's local lesson record (`MemoryRecord`) lives with its only store,
 * in `./memory.ts`.
 */
export type {
  ModelTier,
  UsageTotals,
  TaskStatus,
  Task,
  Plan,
  AgentSnapshot,
  FleetSnapshot,
} from "@oxagen/agent-engine";
export { emptyUsage, mergeUsage } from "@oxagen/agent-engine";
