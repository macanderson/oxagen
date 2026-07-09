/**
 * Shared domain types for the agent fleet — re-exported from
 * `@oxagen/agent-engine`.
 *
 * A *plan* decomposes a goal into *tasks*. A task is assigned to a subagent,
 * which runs the ONE engine loop against the working tree. The fleet
 * orchestrates many of these at once under a concurrency cap, records what each
 * one built/fixed as memory, and feeds the agents screen its live roster.
 *
 * The task/plan/snapshot/usage shapes USED to be a second, hand-maintained copy
 * living here. They are now the engine's single source of truth (the engine's
 * own `Fleet` orchestrator and this CLI both build the same `Task`/`Plan`
 * objects, so a drift between the two copies was a latent structural-mismatch
 * bug). This module re-exports them so every existing `fleet/types.js` import in
 * the CLI keeps resolving unchanged.
 *
 * Two things stay CLI-local, on purpose:
 *   - `AgentDefinition` is NOT re-exported from the engine here — the CLI has
 *     its own richer definition at `apps/cli/src/agents/types.ts`; pulling the
 *     engine's in would shadow it. Import that one directly where needed.
 *   - `MemoryRecord` below is CLI-owned — the engine models memory through its
 *     `MemoryProvider` port, not a flat record, so there is no engine type to
 *     forward to.
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

/** A two-axis lesson recorded as the fleet builds/fixes code. */
export interface MemoryRecord {
  id: string;
  createdAt: number;
  /** Content domain — mirrors the platform `agent.memory.write` memoryKind values. */
  memoryKind:
    | "routine-change"
    | "constraint"
    | "bug-root-cause"
    | "convention-deviation"
    | "gotcha";
  /** Epistemic class — mirrors the platform `agent.memory.write` memoryClass ladder. */
  memoryClass: "OBSERVATION" | "RULE" | "FACT";
  /** How strongly it should influence future work; 1-100 for RULE, null otherwise. */
  enforcementScore: number | null;
  /** The lesson itself, in one or two sentences. */
  lesson: string;
  /** Files the lesson is about (used for lexical recall scoring). */
  files: string[];
  /** Task that produced it, if any. */
  taskId?: string;
  outcome: "success" | "failure";
}
