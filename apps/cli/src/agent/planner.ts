/**
 * Task planner — turn a goal into an executable plan.
 *
 * Decomposes a high-level goal ("add rate limiting to the API and document it")
 * into a small set of concrete, dependency-ordered tasks the fleet can run in
 * parallel. Uses one structured-output model call; the goal is prompt-enhanced
 * first so the planner sees the actual files/symbols involved and produces tasks
 * that name real paths instead of guesses.
 *
 * Each task's tier is reconciled with the cost router: the model proposes a tier,
 * but a task the router flags as high-stakes (auth/billing/security/migration) is
 * always escalated, never under-spent.
 */
import { z } from "zod";
import type { AgentAi } from "@oxagen/agent-engine";
import { enhancePrompt } from "./prompt-enhancer.js";
import { classifyTier, modelForTier } from "./model-router.js";
import { resolveAiCredential, MissingAiKeyError } from "./env.js";
import { createGatewayAgentAi } from "./adapters/index.js";
import { createMeteredAi } from "./metered-ai.js";
import { debugLog } from "../lib/debug-log.js";
import {
  AgentTimeoutError,
  DEFAULT_TIMEOUTS,
  callModelWithTimeout,
  createTurnRunner,
  withTimeout,
} from "./timeouts.js";
import {
  emptyUsage,
  type ModelTier,
  type Plan,
  type Task,
} from "./fleet/types.js";
import type { FleetMemory } from "./fleet/memory.js";
import type { AgentDefinition } from "../agents/types.js";

/**
 * Timeout for prompt enhancement alone. This involves code-graph queries (fast,
 * local) and optional fleet-memory recall — it should be very quick.
 */
const ENHANCE_TIMEOUT_MS = 30_000; // 30s

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
  cwd: string;
  /** Override the planning model slug (otherwise a balanced-tier model). */
  model?: string;
  memory?: FleetMemory | null;
  /** Roster of named agents the planner may assign tasks to. */
  agents?: AgentDefinition[];
  /**
   * AI port the planner's structured-output call goes through — the engine's
   * {@link AgentAi} seam, NOT `generateObject` from `ai` directly (the
   * all-LLM-calls-through-a-metered-seam law: raw `ai` calls skip metering,
   * duration tracking, and prompt hashing). When omitted, a BYOK gateway-direct
   * port is built from `cwd` — the historical unmetered CLI default. An
   * authenticated caller (e.g. a REPL session) passes its own platform-metered
   * port so planning usage lands in the session's metrics.
   */
  ai?: AgentAi;
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
 * Produce an executable {@link Plan} from a goal. Throws
 * {@link MissingAiKeyError} if no AI credential (gateway or Anthropic) is
 * configured.
 */
export async function planTasks(opts: PlanOptions): Promise<Plan> {
  const cwd = opts.cwd;
  if (!resolveAiCredential(cwd)) throw new MissingAiKeyError();

  // Wire the caller's abort signal (Esc/Ctrl-C) into a controller-only turn
  // runner (no inactivity guard: planning is a single enhance + one model call,
  // both individually bounded). There is NO planning-phase wall-clock cap:
  // timeouts live on the individual calls below (enhancement via withTimeout;
  // the LLM call via callModelWithTimeout).
  const planRunner = createTurnRunner({}, { callerSignal: opts.signal });
  const planSignal = planRunner.signal;

  // Enhance the goal so the planner sees the real code involved. Bound
  // separately so a slow code-graph build doesn't eat the whole planning budget.
  let enhanced: Awaited<ReturnType<typeof enhancePrompt>>;
  try {
    enhanced = await withTimeout(
      enhancePrompt({ prompt: opts.goal, cwd, memory: opts.memory }),
      ENHANCE_TIMEOUT_MS,
      planSignal,
      "prompt enhancement",
    );
  } catch (err) {
    // Enhancement is best-effort: a timeout means we fall back to the raw goal
    // rather than failing the whole planning phase.
    if (err instanceof AgentTimeoutError) {
      enhanced = {
        prompt: opts.goal,
        context: "",
        resolved: [],
        usedSemanticFallback: false,
        lessons: [],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        retrieval: {
          symbolsQueried: [],
          pathsQueried: [],
          resolved: [],
          unresolved: [],
        },
      };
    } else {
      throw err;
    }
  }

  const roster = new Set((opts.agents ?? []).map((a) => a.name));
  const rosterBlock =
    opts.agents && opts.agents.length > 0
      ? `\n\nAvailable specialized agents (assign a task's "agent" to one when it clearly fits):\n` +
        opts.agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
      : "";

  const model = opts.model ?? modelForTier("balanced");
  // Route the structured-output call through the engine AI port (metered on the
  // platform, BYOK/unmetered in the CLI) rather than `generateObject` from `ai`.
  // Default to the gateway-direct BYOK port built from cwd — same construction
  // the fleet's engine runner uses — when the caller didn't inject one.
  const ai =
    opts.ai ??
    createMeteredAi(createGatewayAgentAi({ cwd }), {
      onLog: (line) => void debugLog("timeout", line),
    });
  // The planner's model call is bounded per-call (perModelCallMs) and retried on
  // timeout — the timeout lives on the call, not on a turn/phase clock. The
  // per-attempt signal aborts the in-flight request; the outer planSignal
  // (user cancel) propagates without a retry.
  const { object } = await callModelWithTimeout(
    (signal) =>
      ai.generateObject({
        model,
        schema: planSchema,
        system: PLANNER_SYSTEM,
        prompt: `Goal:\n${enhanced.prompt}${rosterBlock}`,
        abortSignal: signal,
      }),
    DEFAULT_TIMEOUTS,
    { callId: "planner", model },
    planSignal,
  );

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
    return {
      id,
      title: t.title,
      description: t.description,
      status: "queued",
      dependsOn: t.dependsOn ?? [],
      files: t.files ?? [],
      tier,
      model: modelForTier(tier),
      agent,
      createdAt: now,
      usage: emptyUsage(),
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
