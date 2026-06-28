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
import { enhancePrompt } from "../evaluate/prompt-enhancer.js";
import { classifyTier, modelForTier } from "../router/model-router.js";
import { emptyUsage } from "../types.js";
import type { ModelTier, UsageTotals, CodeGraphProvider } from "../types.js";
import type { AgentAi, MemoryProvider } from "../ports.js";
import type { AgentDefinition, Plan, Task } from "../fleet/types.js";

export type { Plan, Task };

const TIER_RANK: Record<ModelTier, number> = { fast: 0, balanced: 1, precise: 2 };

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
          .describe("Short kebab-case id, unique within the plan (e.g. 'add-route')."),
        title: z.string().describe("Imperative one-line title."),
        description: z
          .string()
          .describe(
            "Self-contained instructions for an agent that has the repo but not this plan: " +
              "what to change, in which files, and how to verify.",
          ),
        dependsOn: z
          .array(z.string())
          .describe("ids of tasks that must finish first (empty if independent)."),
        files: z
          .array(z.string())
          .describe("Relative paths this task will create or edit, as best you can predict."),
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
  /** Injected AI port — BYOK in the CLI, metered on the platform. */
  ai: AgentAi;
  /** Override the planning model slug (otherwise a balanced-tier model). */
  model?: string;
  /** Memory for recalled context in prompt enhancement. Optional. */
  memory?: MemoryProvider | null;
  /** Code graph for prompt enhancement. Optional. */
  codeGraph?: CodeGraphProvider | null;
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
 * Produce an executable {@link Plan} from a goal. Uses the injected AI port for
 * the planning model call.
 */
export async function planTasks(opts: PlanOptions): Promise<Plan> {
  // Enhance the goal so the planner sees the real code involved.
  const enhanced = await enhancePrompt({
    prompt: opts.goal,
    codeGraph: opts.codeGraph,
    memory: opts.memory,
  });

  const roster = new Set((opts.agents ?? []).map((a) => a.name));
  const rosterBlock =
    opts.agents && opts.agents.length > 0
      ? `\n\nAvailable specialized agents (assign a task's "agent" to one when it clearly fits):\n` +
        opts.agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
      : "";

  const model = opts.model ?? modelForTier("balanced");
  const { object } = await opts.ai.generateObject({
    model,
    schema: planSchema,
    system: PLANNER_SYSTEM,
    prompt: `Goal:\n${enhanced.prompt}${rosterBlock}`,
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
  for (const t of tasks) t.dependsOn = t.dependsOn.filter((d) => ids.has(d) && d !== t.id);

  return {
    id: newPlanId(),
    goal: opts.goal,
    createdAt: now,
    tasks,
    status: "draft",
  };
}
