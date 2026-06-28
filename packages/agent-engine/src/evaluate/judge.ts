/**
 * Completeness judge — the adversarial advisor.
 *
 * Coding agents routinely declare victory while the work is half-done: they
 * describe a change without making it, leave TODOs, skip the tests they promised,
 * or implement one of three asked-for things. This stage exists to catch that.
 *
 * After the executor finishes, a DIFFERENT model (the advisor) re-reads the
 * user's original request alongside what the agent actually *did* — the files it
 * wrote, the commands it ran, and its closing message — and rules on whether the
 * work is genuinely complete. A model judging its own work grades itself
 * generously, so the advisor is always a distinct model from the executor; that
 * independence is the whole point.
 *
 * The verdict feeds the pipeline's auto-revise loop: an "incomplete" verdict with
 * concrete findings is handed straight back to the agent to finish.
 *
 * Unlike the CLI version this does NOT call `generateObject` from `ai` directly —
 * it takes an {@link AgentAi} port.
 */
import { z } from "zod";
import { modelForTier, accumulateUsage } from "../router/model-router.js";
import { emptyUsage } from "../types.js";
import type { AgentAi } from "../ports.js";
import type { JudgeVerdict } from "../trace/types.js";

/**
 * The default completeness advisor: the most powerful OpenAI model. The advisor's
 * job is to catch an executor's blind spots, and a different *vendor* shares none
 * of them — an OpenAI model auditing a (typically Claude) executor is maximally
 * independent. Overridable with `OXAGEN_LLM_ADVISOR` to track gateway slug drift
 * or pick a different judge.
 */
export const DEFAULT_ADVISOR_MODEL = "openai/gpt-5.5-pro";

/**
 * Choose the advisor model — guaranteed distinct from the executor so the work is
 * never graded by the same model that produced it.
 *
 * Order: explicit `OXAGEN_LLM_ADVISOR` (if it differs) → the most powerful OpenAI
 * model (the default cross-vendor judge) → the precise tier → the balanced tier as
 * the last-resort distinct option when the executor is already those models.
 */
export function pickAdvisorModel(executorModel: string): string {
  const override = process.env["OXAGEN_LLM_ADVISOR"];
  if (override && override !== executorModel) return override;
  if (DEFAULT_ADVISOR_MODEL !== executorModel) return DEFAULT_ADVISOR_MODEL;
  // The executor already IS the default advisor — fall back to distinct strong
  // models so work is never graded by the model that produced it.
  const precise = modelForTier("precise");
  if (precise !== executorModel) return precise;
  return modelForTier("balanced");
}

const verdictSchema = z.object({
  complete: z
    .boolean()
    .describe(
      "True ONLY if EVERY part of the user's request was addressed with concrete, " +
        "verifiable changes. If any part is described-but-not-done, partial, or unverified, " +
        "this is false.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(100)
    .describe("0–100 confidence in this verdict."),
  findings: z
    .array(z.string())
    .describe(
      "Specific gaps between what was asked and what was done. Empty only when complete. " +
        "Be concrete: name the missing file, the untested path, the unmet requirement.",
    ),
  remainingWork: z
    .array(z.string())
    .describe("Concrete next actions that would make the work complete. Empty when complete."),
  reasoning: z
    .string()
    .describe("2–4 sentences explaining the verdict, citing the evidence you used."),
});

export interface JudgeOptions {
  /** The user's original request (pre-enhancement). */
  request: string;
  /** The agent's final assistant message. */
  response: string;
  /** Relative paths the agent wrote or edited this turn. */
  filesTouched: string[];
  /** Shell commands the agent ran this turn. */
  commandsRun: string[];
  /** Tool-loop steps the agent took. */
  steps: number;
  /** The executor model, so the advisor is chosen to differ from it. */
  executorModel: string;
  /** Override the advisor model slug. */
  advisorModel?: string;
  signal?: AbortSignal;
}

const JUDGE_SYSTEM = [
  "You are a skeptical completeness judge auditing another AI agent's coding work.",
  "Agents frequently CLAIM a task is done when it is not: they describe edits without",
  "making them, leave TODOs, skip promised tests, or finish only part of the request.",
  "Your job is to catch exactly that. Default to skepticism.",
  "",
  "You are given the user's request, the agent's final message, and the concrete",
  "evidence of what it did (files written/edited, commands run, step count). Judge the",
  "WORK, not the prose. A confident closing message with no matching file changes is a",
  "red flag, not proof.",
  "",
  "Mark complete=true ONLY when every distinct part of the request is satisfied by real,",
  "verifiable changes. Otherwise list concrete findings and the remaining work. If the",
  "request was a question or read-only analysis, completeness means the question is fully",
  "answered — file changes are not required.",
].join("\n");

function evidenceBlock(opts: JudgeOptions): string {
  const files =
    opts.filesTouched.length > 0
      ? opts.filesTouched.map((f) => `  - ${f}`).join("\n")
      : "  (none — the agent wrote or edited no files)";
  const cmds =
    opts.commandsRun.length > 0
      ? opts.commandsRun.map((c) => `  - ${c}`).join("\n")
      : "  (none)";
  return [
    `## User's request\n${opts.request}`,
    `## Agent's final message\n${opts.response || "(empty)"}`,
    `## Files the agent wrote/edited (${opts.filesTouched.length})\n${files}`,
    `## Commands the agent ran (${opts.commandsRun.length})\n${cmds}`,
    `## Tool-loop steps taken: ${opts.steps}`,
  ].join("\n\n");
}

/**
 * Heuristic verdict for when the advisor model is unavailable. Conservative: it
 * flags the obvious "claimed a change but touched no files" case and otherwise
 * abstains to a low-confidence "complete" so a model outage never wedges the loop.
 */
function heuristicVerdict(opts: JudgeOptions, model: string): JudgeVerdict {
  const claimsChange =
    /\b(added|created|updated|edited|implemented|fixed|wrote|changed|refactored|removed|deleted)\b/i.test(
      opts.response,
    );
  const touchedNothing = opts.filesTouched.length === 0 && opts.commandsRun.length === 0;
  if (claimsChange && touchedNothing) {
    return {
      complete: false,
      confidence: 60,
      findings: ["The agent described changes but wrote or edited no files."],
      remainingWork: ["Actually apply the described changes to the relevant files."],
      reasoning: "Heuristic check (advisor unavailable): claimed edits with no file activity.",
      model,
      fallback: true,
      usage: emptyUsage(),
    };
  }
  return {
    complete: true,
    confidence: 30,
    findings: [],
    remainingWork: [],
    reasoning: "Heuristic check (advisor unavailable): no obvious incompleteness signal.",
    model,
    fallback: true,
    usage: emptyUsage(),
  };
}

/**
 * Judge whether the agent's work is complete. Always returns a verdict — on model
 * failure it falls back to a conservative heuristic rather than throwing.
 *
 * @param opts  - Judge options (request, response, evidence).
 * @param ai    - Injected AI port. The platform wires in a metered implementation;
 *                the CLI wires in a BYOK one.
 */
export async function judgeCompleteness(opts: JudgeOptions, ai: AgentAi): Promise<JudgeVerdict> {
  const model = opts.advisorModel ?? pickAdvisorModel(opts.executorModel);
  try {
    const { object, usage } = await ai.generateObject({
      model,
      schema: verdictSchema,
      system: JUDGE_SYSTEM,
      prompt: evidenceBlock(opts),
      abortSignal: opts.signal,
    });
    return {
      complete: object.complete,
      confidence: Math.max(0, Math.min(100, Math.round(object.confidence))),
      findings: object.findings,
      remainingWork: object.remainingWork,
      reasoning: object.reasoning,
      model,
      fallback: false,
      usage: accumulateUsage(emptyUsage(), model, usage),
    };
  } catch {
    return heuristicVerdict(opts, model);
  }
}

/**
 * Compose the follow-up prompt that drives the agent to finish incomplete work.
 * Exported so the REPL and tests can show/inspect exactly what the agent is told.
 */
export function buildRevisionPrompt(verdict: JudgeVerdict): string {
  const findings = verdict.findings.map((f) => `- ${f}`).join("\n");
  const work = verdict.remainingWork.map((w) => `- ${w}`).join("\n");
  return [
    "A completeness review found your previous work is NOT done. Do not re-explain — finish it.",
    "",
    findings ? `Gaps found:\n${findings}` : "",
    work ? `\nRemaining work:\n${work}` : "",
    "",
    "Make the actual changes now, then briefly confirm what you changed.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}
