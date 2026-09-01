/**
 * Task planner — turn a goal into an executable plan.
 *
 * Decomposes a high-level goal ("add rate limiting to the API and document it")
 * into a small set of concrete, dependency-ordered tasks the fleet can run in
 * parallel. Uses one structured-output model call via the injected {@link AgentAi}
 * port; the goal is prompt-enhanced first so the planner sees the actual
 * files/symbols involved and produces tasks that name real paths.
 *
 * Each task's tier is reconciled with the cost router: the model proposes a tier,
 * but a task the router flags as high-stakes (auth/billing/security/migration) is
 * always escalated, never under-spent.
 *
 * Unlike the CLI version, this does NOT call `generateObject` from `ai` directly
 * or read a config file — it takes an {@link AgentAi} port.
 */
import { z } from "zod";
import { enhancePrompt } from "../evaluate/prompt-enhancer";
import { classifyTier, modelForTier } from "../router/model-router";
import { emptyUsage } from "../types";
import type { ModelTier, UsageTotals } from "../types";
import type { AgentAi, MemoryProvider } from "../ports";
import type { AgentDefinition, Plan, Task } from "../fleet/types";

export type { Plan, Task };

const TIER_RANK: Record<ModelTier, number> = {
  fast: 0,
  balanced: 1,
  precise: 2,
};

/** The more capable of two tiers (never under-spend on a risky task). */
function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

const planSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z
          .string()
          .describe(
            "Short kebab-case id, unique within the plan (e.g. 'add-route').",
          ),
        title: z.string().describe("Imperative one-line title."),
        description: z
          .string()
          .describe(
            "Self-contained instructions for an agent that has the repo but not this plan: " +
              "what to change, in which files, and how to verify.",
          ),
        dependsOn: z
          .array(z.string())
          .describe(
            "ids of tasks that must finish first (empty if independent).",
          ),
        files: z
          .array(z.string())
          .describe(
            "Relative paths this task will create or edit, as best you can predict.",
          ),
        tier: z
          .enum(["fast", "balanced", "precise"])
          .describe(
            "Model tier: 'fast' for mechanical/single-file, 'balanced' for normal feature work, " +
              "'precise' for auth/billing/security/migrations/architecture.",
          ),
        agent: z
          .string()
          .optional()
          .describe(
            "Name of a specialized agent from the roster to handle this task, when one clearly " +
              "fits. Omit to use the general-purpose agent.",
          ),
      }),
    )
    .min(1)
    .max(20),
});

export interface PlanOptions {
  goal: string;
  /**
   * Conversational context for reference resolution ONLY — e.g. a digest of the
   * recent turns so a follow-up like "now do the same for the API" resolves
   * "the same". It is NEVER part of the goal: it must not be concatenated into
   * `goal`, and it deliberately does not influence the single-task heuristic
   * ({@link isSingleTaskGoal}), so a trivial goal still takes the fast path even
   * on a history-bearing turn. When the model planner runs, it is rendered as its
   * own labeled block ahead of the goal.
   */
  context?: string;
  /** Injected AI port — BYOK in the CLI, metered on the platform. */
  ai: AgentAi;
  /** Override the planning model slug (otherwise a balanced-tier model). */
  model?: string;
  /** Memory for recalled context in prompt enhancement. Optional. */
  memory?: MemoryProvider | null;
  /** Roster of named agents the planner may assign tasks to. */
  agents?: AgentDefinition[];
  signal?: AbortSignal;
}

let planCounter = 0;
function newPlanId(): string {
  planCounter = (planCounter + 1) % 1_000_000;
  return `plan_${Date.now().toString(36)}_${planCounter.toString(36)}`;
}

const PLANNER_SYSTEM = [
  "You are the planning stage of an agentic coding system. Decompose the user's goal",
  "into the SMALLEST set of concrete, independently-runnable tasks that fully achieve it.",
  "",
  "Rules:",
  "- Prefer few, substantial tasks over many trivial ones. A one-file change is one task.",
  "- Make tasks parallel where possible; only add a dependency when one task's output is",
  "  genuinely required by another (e.g. a contract must exist before a route uses it).",
  "- Predict the files each task touches; tasks that edit the same file should depend in",
  "  sequence rather than run concurrently.",
  "- Assign the cheapest sufficient tier per task; reserve 'precise' for auth, billing,",
  "  security, migrations, schema, or architectural changes.",
  "- Every task description must stand alone — the executing agent sees only its own task.",
].join("\n");

/**
 * Does this goal trivially map to a SINGLE task? A deterministic, conservative
 * heuristic (ADR-021 §1): true only when the goal has no conjunctions, list
 * markers, multiple sentences, or multiplicity words — i.e. it is obviously one
 * unit of work. It ERRS TOWARD PLANNING (returns false) whenever there is any
 * doubt, so the model planner still runs for anything genuinely multi-part.
 * Exported for tests.
 */
export function isSingleTaskGoal(goal: string): boolean {
  const g = goal.trim();
  if (g.length === 0) return false;
  // Too long to confidently call one task.
  if (g.length > 120) return false;
  // Multi-line, or a numbered / bulleted list ⇒ multiple items.
  if (/\n/.test(g)) return false;
  if (/(^|\s)(\d+[.)]|[-*•])\s/.test(g)) return false;
  // A second sentence usually carries a second imperative.
  if (/[.!?]\s+\S/.test(g)) return false;
  // Enumeration / clause separators.
  if (/[,;&]/.test(g)) return false;
  // Coordinating conjunctions and sequencing words join multiple actions.
  if (
    /\b(and|then|also|plus|next|afterwards?|finally|as well as|followed by)\b/i.test(
      g,
    )
  )
    return false;
  // Explicit multiplicity.
  if (/\b(both|each|every|all of|multiple|several|various)\b/i.test(g))
    return false;
  return true;
}

/**
 * Produce an executable {@link Plan} from a goal. Uses the injected AI port for
 * the planning model call — EXCEPT when the goal trivially maps to a single task
 * (see {@link isSingleTaskGoal}), in which case the plan is synthesized
 * deterministically with no planner model call (ADR-021 §1).
 */
export async function planTasks(opts: PlanOptions): Promise<Plan> {
  // Deterministic single-task fast-path: a goal with no conjunctions, list
  // markers, or multi-part signals is one task. Skip the planner model call (and
  // the enhancement round-trip) and synthesize the plan directly. The executing
  // agent still gathers its own context, so a bare description loses nothing.
  if (isSingleTaskGoal(opts.goal)) {
    const now = Date.now();
    const goal = opts.goal.trim();
    const tier = classifyTier({ text: goal }).tier;
    const task: Task = {
      id: "task-1",
      title: goal,
      description: goal,
      status: "queued",
      dependsOn: [],
      files: [],
      tier,
      model: modelForTier(tier),
      agent: undefined,
      createdAt: now,
      usage: emptyUsage(),
    };
    return {
      id: newPlanId(),
      goal: opts.goal,
      createdAt: now,
      tasks: [task],
      status: "draft",
    };
  }

  // Enhance the goal with what past sessions learned about this repository.
  const enhanced = await enhancePrompt({
    prompt: opts.goal,
    memory: opts.memory,
  });

  const roster = new Set((opts.agents ?? []).map((a) => a.name));
  const rosterBlock =
    opts.agents && opts.agents.length > 0
      ? `\n\nAvailable specialized agents (assign a task's "agent" to one when it clearly fits):\n` +
        opts.agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
      : "";

  // Perf #9: decomposing a goal into a handful of tasks is a bounded structured-
  // output job the fast tier handles well — default to it, escalating only when
  // the goal itself hits a high-stakes domain (auth/billing/security/migration/
  // architecture) where a mis-decomposition is costly. An explicit triage model
  // (`opts.model`, the `/triage-model` slug) always wins over this default. Note
  // per-task tiers are still reconciled up by `classifyTier` below, so a fast
  // planner never under-tiers the WORKERS — only its own decomposition call.
  const plannerTier = classifyTier({ text: opts.goal }).tier;
  const model =
    opts.model ?? modelForTier(plannerTier === "precise" ? "precise" : "fast");
  // Conversational context (reference resolution) leads, then the enhanced goal.
  // The enhance call above operates on the RAW goal; context is a separate block
  // so it informs decomposition without ever becoming part of the goal.
  const contextBlock = opts.context ? `${opts.context}\n\n` : "";
  const { object } = await opts.ai.generateObject({
    model,
    schema: planSchema,
    system: PLANNER_SYSTEM,
    prompt: `${contextBlock}Goal:\n${enhanced.prompt}${rosterBlock}`,
    abortSignal: opts.signal,
  });

  const now = Date.now();
  const seen = new Set<string>();
  const tasks: Task[] = object.tasks.map((t, i) => {
    // Guarantee unique, non-empty ids even if the model repeats or omits them.
    let id = (t.id || `task-${i + 1}`).trim();
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    // Reconcile the proposed tier with the router's read of the description.
    const routed = classifyTier({
      text: `${t.title} ${t.description}`,
      fileCount: t.files.length,
    }).tier;
    const tier = maxTier(t.tier as ModelTier, routed);
    // Keep an agent assignment only if it names a real agent in the roster.
    const agent = t.agent && roster.has(t.agent) ? t.agent : undefined;
    const usage: UsageTotals = emptyUsage();
    return {
      id,
      title: t.title,
      description: t.description,
      status: "queued" as const,
      dependsOn: t.dependsOn ?? [],
      files: t.files ?? [],
      tier,
      model: modelForTier(tier),
      agent,
      createdAt: now,
      usage,
    };
  });

  // Drop dependencies that point at ids no task actually has (model hallucination).
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks)
    t.dependsOn = t.dependsOn.filter((d) => ids.has(d) && d !== t.id);

  return {
    id: newPlanId(),
    goal: opts.goal,
    createdAt: now,
    tasks,
    status: "draft",
  };
}
