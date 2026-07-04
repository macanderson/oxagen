/**
 * Per-turn planning for the interactive REPL — every turn gets a REAL plan.
 *
 * The Task Progress panel used to be seeded with the pipeline's fixed stage
 * titles ("Evaluate the request", …) — a hardcoded checklist masquerading as a
 * plan. This module replaces that: each submission is decomposed by the engine's
 * structured-output planner (`planTasks` from `@oxagen/agent-engine`, driven by
 * the session's own AI port, so it works for platform-metered and BYOK sessions
 * alike) into concrete, dependency-ordered tasks. Multi-task plans are executed
 * by the fleet as parallel subagents (see fleet-turn.ts); single-task plans stay
 * in the history-aware main loop.
 *
 * The planner sees a compact digest of the recent conversation so follow-ups
 * ("now do the same for the API") plan correctly, not in a vacuum. When the
 * planner call fails (no credential, gateway hiccup) the turn degrades to a
 * genuine single-task plan derived from the submission itself — routed through
 * the cost router like any ad-hoc dispatch, never an invented checklist.
 */
import {
  planTasks as enginePlanTasks,
  type AgentAi,
  type CodeGraphProvider,
  type MemoryProvider,
} from "@oxagen/agent-engine";
import type { ModelMessage } from "ai";
import { routeModel } from "../agent/model-router.js";
import { emptyUsage, type Plan, type Task } from "../agent/fleet/types.js";
import type { AgentDefinition } from "../agents/types.js";

/** How much recent conversation the planner sees (chars, after extraction). */
const HISTORY_DIGEST_MAX_CHARS = 2_000;
/** How many trailing messages are considered for the digest. */
const HISTORY_DIGEST_MAX_MESSAGES = 6;

/** The planner function signature, injectable for tests. */
export type PlanFn = typeof enginePlanTasks;

export interface PlanReplTurnOptions {
  /** The user's submission (paste placeholders already expanded). */
  goal: string;
  /** Prior conversation, newest last — digested into planner context. */
  history: ModelMessage[];
  /** The session's AI port (platform-metered or BYOK — whichever is active). */
  ai: AgentAi;
  codeGraph?: CodeGraphProvider | null;
  memory?: MemoryProvider | null;
  /** Named agent roster the planner may assign tasks to. */
  agents?: AgentDefinition[];
  signal?: AbortSignal;
  /** Test seam; defaults to the engine planner. */
  planFn?: PlanFn;
}

/** Extract the readable text of one ModelMessage (string or parts array). */
function messageText(msg: ModelMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * A compact `user:`/`assistant:` transcript of the conversation tail, so the
 * planner resolves references like "that file" / "do the same for X". Tool and
 * system messages are skipped — they're noise at planning altitude.
 */
export function historyDigest(history: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of history.slice(-HISTORY_DIGEST_MAX_MESSAGES)) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = messageText(msg).trim();
    if (!text) continue;
    const budget = Math.floor(HISTORY_DIGEST_MAX_CHARS / HISTORY_DIGEST_MAX_MESSAGES);
    lines.push(`${msg.role}: ${text.length > budget ? text.slice(0, budget) + "…" : text}`);
  }
  return lines.join("\n").slice(-HISTORY_DIGEST_MAX_CHARS);
}

/**
 * A genuine one-task plan built straight from the submission — the degraded
 * path when the planner model is unreachable, and the whole plan in bare mode
 * (where the user opted out of pipeline model calls). Tier/model come from the
 * cost router, exactly like an ad-hoc fleet dispatch.
 */
export function fallbackPlan(goal: string): Plan {
  const decision = routeModel({ text: goal });
  const task: Task = {
    id: "task-1",
    title: goal.length > 64 ? goal.slice(0, 61) + "…" : goal,
    description: goal,
    status: "queued",
    dependsOn: [],
    files: [],
    tier: decision.tier,
    model: decision.model,
    createdAt: Date.now(),
    usage: emptyUsage(),
  };
  return {
    id: `plan_${Date.now().toString(36)}_fallback`,
    goal,
    createdAt: Date.now(),
    tasks: [task],
    status: "draft",
  };
}

/**
 * Plan the turn. Returns a real, model-generated {@link Plan}; degrades to
 * {@link fallbackPlan} only when the planner call itself fails. A user cancel
 * (aborted signal) is re-thrown so the turn cancels instead of "planning".
 */
export async function planReplTurn(opts: PlanReplTurnOptions): Promise<Plan> {
  const digest = historyDigest(opts.history);
  const goal = digest
    ? `Conversation so far (for reference resolution):\n${digest}\n\nCurrent request:\n${opts.goal}`
    : opts.goal;
  try {
    // Resolved inside the try: an engine build (or test mock) without a
    // planner export degrades to the fallback plan, same as a failed call.
    const plan = opts.planFn ?? enginePlanTasks;
    const planned = await plan({
      goal,
      ai: opts.ai,
      codeGraph: opts.codeGraph ?? null,
      memory: opts.memory ?? null,
      agents: (opts.agents ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        systemPrompt: a.systemPrompt,
        tools: a.tools,
        model: a.model,
      })),
      signal: opts.signal,
    });
    // Rehome the goal onto the raw submission (the digest prefix is planner
    // input, not something to persist or replay).
    return { ...planned, goal: opts.goal, tasks: planned.tasks as Task[] };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return fallbackPlan(opts.goal);
  }
}
