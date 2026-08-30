import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { getCapability, getSurfaces, listCapabilities } from "@oxagen/oxagen";
import { getCapabilityChain } from "@oxagen/oxagen/capability-meta";
import { agentCompose } from "@oxagen/oxagen/contracts/agent.compose";
import type { ComposeStepResult } from "@oxagen/oxagen/contracts/agent.compose";
import { invoke } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

// ── Binding resolution ($steps.<id>.<dotpath>) ───────────────────────────────
// A planned step input may reference a prior step's output. An EXACT-match
// binding (the whole string is one token) resolves to the raw value (preserving
// type); an EMBEDDED token inside a larger string is string-interpolated.
const TOKEN_SRC = "\\$steps\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_.]+)";
const EXACT_TOKEN = new RegExp(`^${TOKEN_SRC}$`);
const ANY_TOKEN = new RegExp(TOKEN_SRC);
const GLOBAL_TOKEN = new RegExp(TOKEN_SRC, "g");

/** Read a dot-path out of an unknown value. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object")
      return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Recursively replace $steps.<id>.<path> references in a planned input with
 * values from already-completed step outputs.
 */
export function resolveBindings(
  value: unknown,
  outputs: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const exact = EXACT_TOKEN.exec(value);
    if (exact) {
      const resolved = readPath(
        outputs[exact[1] as string],
        exact[2] as string,
      );
      return resolved === undefined ? value : resolved;
    }
    if (ANY_TOKEN.test(value)) {
      return value.replace(GLOBAL_TOKEN, (_m, id: string, path: string) => {
        const r = readPath(outputs[id], path);
        if (r === undefined || r === null) return "";
        return typeof r === "object" ? JSON.stringify(r) : String(r);
      });
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((v) => resolveBindings(v, outputs));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = resolveBindings(v, outputs);
    return out;
  }
  return value;
}

/**
 * Topologically order steps by their dependsOn edges. Throws on a cycle.
 * An unknown dependency id contributes no ordering edge here, so the dependent
 * step still appears in the returned order; the executor then finds no success
 * status for that id and skips the step as dependency-blocked.
 */
export function topoSort(
  steps: ReadonlyArray<{ id: string; dependsOn: string[] }>,
): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const order: string[] = [];
  const visit = (id: string): void => {
    const st = state.get(id);
    if (st === 2) return;
    if (st === 1) throw new Error(`Cycle detected at step "${id}"`);
    const step = byId.get(id);
    if (!step) return;
    state.set(id, 1);
    for (const dep of step.dependsOn) visit(dep);
    state.set(id, 2);
    order.push(id);
  };
  for (const s of steps) visit(s.id);
  return order;
}

/**
 * Whether a capability is safe to AUTO-execute inside a compose chain.
 * Destructive or approval-required capabilities are planned but never run
 * automatically — a human must invoke them deliberately.
 */
export function isSafeToAutoExecute(
  cap:
    | { sensitivity?: string; agent?: { requiresApproval?: boolean } }
    | undefined,
): boolean {
  if (!cap) return false;
  if (cap.sensitivity === "destructive") return false;
  if (cap.agent?.requiresApproval === true) return false;
  return true;
}

// ── Planner ──────────────────────────────────────────────────────────────────

interface CatalogEntry {
  name: string;
  description: string;
  produces: readonly string[];
  consumes: readonly string[];
  chainHints: readonly string[];
}

/** Build the agent-surface capability catalog the planner chooses from. */
export function buildCatalog(): CatalogEntry[] {
  return listCapabilities()
    .filter((c) => getSurfaces(c).includes("agent"))
    .filter((c) => c.name !== agentCompose.name) // never plan a recursive compose
    .map((c) => {
      const chain = getCapabilityChain(c.name);
      return {
        name: c.name,
        description: c.description,
        produces: chain.produces,
        consumes: chain.consumes,
        chainHints: chain.chainHints,
      };
    });
}

const planSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string(),
        capability: z.string(),
        rationale: z.string(),
        inputJson: z.string(),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .max(10),
});

function formatCatalog(catalog: CatalogEntry[]): string {
  return catalog
    .map((c) => {
      const tags: string[] = [];
      if (c.produces.length) tags.push(`produces: ${c.produces.join(", ")}`);
      if (c.consumes.length) tags.push(`consumes: ${c.consumes.join(", ")}`);
      if (c.chainHints.length)
        tags.push(`commonly followed by: ${c.chainHints.join(", ")}`);
      const meta = tags.length ? ` [${tags.join(" | ")}]` : "";
      return `- ${c.name}: ${c.description}${meta}`;
    })
    .join("\n");
}

async function readWorkspacePrompt(ctx: CapabilityContext): Promise<string> {
  try {
    const out = (await invoke("get_prompt_settings", {}, ctx)) as {
      additionalInstructions?: string | null;
    };
    return out.additionalInstructions ?? "";
  } catch {
    return "";
  }
}

async function readEnabledSkills(ctx: CapabilityContext): Promise<string> {
  const out = (await invoke("list_workspace_skills", {}, ctx)) as {
    skills?: Array<{ name: string; description: string; enabled: boolean }>;
  };
  const enabled = (out.skills ?? []).filter((s) => s.enabled);
  if (enabled.length === 0) return "";
  return enabled.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

interface PlannedStep {
  id: string;
  capability: string;
  rationale: string;
  inputJson: string;
  dependsOn: string[];
}

async function planChain(args: {
  goal: string;
  maxSteps: number;
  context?: string;
  workspacePrompt: string;
  skills: string;
  catalog: CatalogEntry[];
  ctx: CapabilityContext;
}): Promise<PlannedStep[]> {
  const { goal, maxSteps, context, workspacePrompt, skills, catalog, ctx } =
    args;

  const prompt = [
    `You are a planner that composes a chain of platform capabilities to accomplish a goal.`,
    ``,
    `GOAL: ${goal}`,
    context ? `\nADDITIONAL CONTEXT: ${context}` : "",
    workspacePrompt
      ? `\nWORKSPACE INSTRUCTIONS (honor these): ${workspacePrompt}`
      : "",
    skills
      ? `\nENABLED SKILLS (use as guidance for what to extract / how to act):\n${skills}`
      : "",
    ``,
    `AVAILABLE CAPABILITIES (choose only from these names):`,
    formatCatalog(catalog),
    ``,
    `Rules:`,
    `- Produce at most ${maxSteps} steps. Fewer is better.`,
    `- Each step's "inputJson" is a JSON object string for that capability's input.`,
    `- To feed a prior step's output into a later step, use a binding string`,
    `  "$steps.<id>.<dotpath>" inside inputJson (e.g. "$steps.step1.nodeId").`,
    `- Set "dependsOn" to the ids of steps whose output this step needs.`,
    `- Prefer capabilities whose "produces" tags match a later step's "consumes" tags.`,
    `- Do not invent capability names. Return JSON { steps: [...] }.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { object } = await generateObjectFor({
    schema: planSchema,
    prompt,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId: ctx.messageId ?? ctx.requestId,
    },
  });

  // Normalize to the concrete PlannedStep shape (dependsOn always an array) —
  // the schema's .default([]) leaves dependsOn optional in the inferred input type.
  return object.steps.slice(0, maxSteps).map((s) => ({
    id: s.id,
    capability: s.capability,
    rationale: s.rationale,
    inputJson: s.inputJson,
    dependsOn: s.dependsOn ?? [],
  }));
}

// ── Executor ─────────────────────────────────────────────────────────────────

async function executePlan(
  plan: PlannedStep[],
  ctx: CapabilityContext,
): Promise<ComposeStepResult[]> {
  const byId = new Map(plan.map((p) => [p.id, p]));
  const outputs: Record<string, unknown> = {};
  const statusById = new Map<string, ComposeStepResult["status"]>();
  const results: ComposeStepResult[] = [];

  let order: string[];
  try {
    order = topoSort(plan);
  } catch {
    // A cyclic plan can't be executed — return every step as skipped.
    return plan.map((p) => ({
      id: p.id,
      capability: p.capability,
      rationale: p.rationale,
      status: "skipped" as const,
      input: null,
      error: "Plan contains a dependency cycle.",
      durationMs: 0,
    }));
  }

  for (const id of order) {
    const step = byId.get(id);
    if (!step) continue;
    const startedAt = Date.now();
    const base = {
      id: step.id,
      capability: step.capability,
      rationale: step.rationale,
    };

    // A failed/skipped dependency blocks this step.
    const depBlocked = step.dependsOn.some(
      (d) => statusById.get(d) !== "success",
    );
    if (depBlocked) {
      statusById.set(id, "skipped");
      results.push({
        ...base,
        status: "skipped",
        input: null,
        error: "A prerequisite step did not complete successfully.",
        durationMs: 0,
      });
      continue;
    }

    // Parse the planned input JSON.
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(step.inputJson || "{}");
    } catch {
      statusById.set(id, "error");
      results.push({
        ...base,
        status: "error",
        input: null,
        error: "Planned input was not valid JSON.",
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    const resolvedInput = resolveBindings(parsedInput, outputs);
    const inputRecord =
      resolvedInput &&
      typeof resolvedInput === "object" &&
      !Array.isArray(resolvedInput)
        ? (resolvedInput as Record<string, unknown>)
        : { value: resolvedInput };

    // Safety gate: unknown / destructive / approval-required → plan only.
    const cap = getCapability(step.capability);
    if (!cap) {
      statusById.set(id, "skipped");
      results.push({
        ...base,
        status: "skipped",
        input: inputRecord,
        error: `Unknown capability "${step.capability}".`,
        durationMs: Date.now() - startedAt,
      });
      continue;
    }
    if (!isSafeToAutoExecute(cap)) {
      statusById.set(id, "skipped");
      results.push({
        ...base,
        status: "skipped",
        input: inputRecord,
        error:
          "Capability is destructive or requires approval — not auto-executed.",
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    // Execute through the kernel (IAM / billing / entitlement gates all apply).
    try {
      const output = await invoke(step.capability, resolvedInput, ctx, {
        surface: "agent",
      });
      outputs[id] = output;
      statusById.set(id, "success");
      results.push({
        ...base,
        status: "success",
        input: inputRecord,
        output,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      statusById.set(id, "error");
      results.push({
        ...base,
        status: "error",
        input: inputRecord,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  return results;
}

// ── Summary ──────────────────────────────────────────────────────────────────

const summarySchema = z.object({ summary: z.string() });

async function summarize(args: {
  goal: string;
  steps: ComposeStepResult[];
  executed: boolean;
  ctx: CapabilityContext;
}): Promise<string> {
  const { goal, steps, executed, ctx } = args;
  const stepLines = steps
    .map((s) => {
      const out =
        s.status === "success"
          ? ` → ${truncateForPrompt(JSON.stringify(s.output))}`
          : s.error
            ? ` → ${s.status}: ${s.error}`
            : ` → ${s.status}`;
      return `- ${s.capability} (${s.status})${out}`;
    })
    .join("\n");

  try {
    const { object } = await generateObjectFor({
      schema: summarySchema,
      prompt: [
        executed
          ? `Summarize, for the user, the result of running this capability chain.`
          : `Summarize, for the user, this PROPOSED capability chain (not yet executed).`,
        `\nGOAL: ${goal}`,
        `\nSTEPS:\n${stepLines}`,
        `\nWrite 2-4 sentences in plain language. State what was accomplished (or proposed),`,
        `mention concrete results (counts, names, ids) where present, and call out any failures.`,
        `Return JSON { summary: string }.`,
      ].join("\n"),
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId: ctx.messageId ?? ctx.requestId,
      },
    });
    return object.summary;
  } catch {
    // Never fail the whole compose because the summary LLM call hiccupped.
    const ok = steps.filter((s) => s.status === "success").length;
    return `Ran ${steps.length} step(s) toward "${goal}": ${ok} succeeded.`;
  }
}

function truncateForPrompt(s: string, max = 600): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const agentComposeHandler: CapabilityHandler<
  typeof agentCompose
> = async (input, ctx) => {
  const [workspacePrompt, skills] = await Promise.all([
    readWorkspacePrompt(ctx),
    readEnabledSkills(ctx),
  ]);
  const catalog = buildCatalog();

  const plan = await planChain({
    goal: input.goal,
    maxSteps: input.maxSteps,
    context: input.context,
    workspacePrompt,
    skills,
    catalog,
    ctx,
  });

  const executed = input.autoExecute;
  const steps: ComposeStepResult[] = executed
    ? await executePlan(plan, ctx)
    : plan.map((p) => ({
        id: p.id,
        capability: p.capability,
        rationale: p.rationale,
        status: "skipped" as const,
        input: null,
        error: "Dry run — not executed.",
        durationMs: 0,
      }));

  const summary = await summarize({ goal: input.goal, steps, executed, ctx });

  logger.info(
    {
      goal: input.goal,
      planSteps: plan.length,
      executed,
      succeeded: steps.filter((s) => s.status === "success").length,
    },
    "agent.compose completed",
  );

  return { goal: input.goal, plan, steps, summary, executed };
};
