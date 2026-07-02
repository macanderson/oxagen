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
import { modelForTier, accumulateUsage } from "../router/model-router";
import { emptyUsage } from "../types";
import type { AgentAi } from "../ports";
import type { JudgeVerdict } from "../trace/types";

/**
 * The default completeness advisor: a capable cross-vendor OpenAI model. The
 * advisor's job is to catch an executor's blind spots, and a different *vendor*
 * shares none of them — an OpenAI model auditing a (typically Claude) executor
 * is maximally independent. Overridable with `OXAGEN_LLM_ADVISOR` to track
 * gateway slug drift or pick a different judge.
 */
export const DEFAULT_ADVISOR_MODEL = "openai/gpt-4o";

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
  /**
   * The actual `git diff` of the turn — the ground-truth change, not the agent's
   * description of it. When present the judge is told to read THIS, not the prose.
   */
  diff?: string;
  /**
   * Outputs of shell commands the agent ran, especially test runs. A failing
   * test here means the work is incomplete regardless of what the agent claims —
   * this is the strongest completeness signal there is.
   */
  commandOutputs?: Array<{ command: string; output: string; ok: boolean }>;
  /** Tool-loop steps the agent took. */
  steps: number;
  /** The executor model, so the advisor is chosen to differ from it. */
  executorModel: string;
  /** Override the advisor model slug. */
  advisorModel?: string;
  signal?: AbortSignal;
}

/** Keep a string's head + tail, dropping the middle (test verdicts live at the tail). */
function headTail(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.5);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [${s.length - max} chars elided]\n${s.slice(s.length - tail)}`;
}

const JUDGE_SYSTEM = [
  "You are a skeptical completeness judge auditing another AI agent's coding work.",
  "Agents frequently CLAIM a task is done when it is not: they describe edits without",
  "making them, leave TODOs, skip promised tests, or finish only part of the request.",
  "Your job is to catch exactly that. Default to skepticism.",
  "",
  "You are given the user's request, the agent's final message, and — crucially — the",
  "GROUND-TRUTH EVIDENCE of what it did: the actual git diff, the output of the commands",
  "it ran, the files touched, and the step count. Judge the EVIDENCE, not the prose.",
  "",
  "Evidence priority, highest first:",
  "1. TEST OUTPUT. If the agent ran tests, their output is decisive. A failing test,",
  "   error, traceback, or non-zero exit means the work is INCOMPLETE — no matter how",
  "   confident the agent's message is. Passing tests that actually exercise the change",
  "   are the strongest completeness signal.",
  "2. THE GIT DIFF. This is the real change. If it is empty, or does not implement what",
  "   was asked, the work is incomplete regardless of the closing message. Read it.",
  "3. The agent's message is a CLAIM to verify against 1 and 2, never proof on its own.",
  "",
  "Mark complete=true ONLY when the diff implements every distinct part of the request AND",
  "any tests that were run pass. If tests were promised/relevant but never run, that is a",
  "finding. If the request was a question or read-only analysis, completeness means the",
  "question is fully answered — file changes are not required.",
].join("\n");

function evidenceBlock(opts: JudgeOptions): string {
  const files =
    opts.filesTouched.length > 0
      ? opts.filesTouched.map((f) => `  - ${f}`).join("\n")
      : "  (none — the agent wrote or edited no files)";
  const diff =
    opts.diff && opts.diff.trim()
      ? "```diff\n" + headTail(opts.diff, 8000) + "\n```"
      : "  (empty — the agent changed no tracked files)";
  const cmdOutputs =
    opts.commandOutputs && opts.commandOutputs.length > 0
      ? opts.commandOutputs
          .map(
            (c) =>
              `  $ ${c.command}  → ${c.ok ? "exit 0" : "FAILED"}\n${headTail(c.output || "(no output)", 3000)
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")}`,
          )
          .join("\n\n")
      : opts.commandsRun.length > 0
        ? opts.commandsRun.map((c) => `  - ${c} (output not captured)`).join("\n")
        : "  (none)";
  return [
    `## User's request\n${opts.request}`,
    `## Agent's final message (a CLAIM — verify it)\n${opts.response || "(empty)"}`,
    `## GIT DIFF (ground truth)\n${diff}`,
    `## Command outputs (test results are decisive)\n${cmdOutputs}`,
    `## Files the agent wrote/edited (${opts.filesTouched.length})\n${files}`,
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
  // Score based on concrete evidence: files touched and commands run are the
  // strongest signals we have without a model. Steps > 0 shows the agent did
  // real tool-loop work. Cap at 70 — the heuristic can't read the diff.
  const evidenceScore =
    opts.filesTouched.length > 0
      ? Math.min(70, 50 + opts.filesTouched.length * 5)
      : opts.commandsRun.length > 0
        ? 50
        : opts.steps > 0
          ? 40
          : 30;
  return {
    complete: true,
    confidence: evidenceScore,
    findings: [],
    remainingWork: [],
    reasoning: `Heuristic check (advisor unavailable): ${opts.filesTouched.length} file(s) touched, ${opts.commandsRun.length} command(s) run, ${opts.steps} step(s) taken — no obvious incompleteness signal.`,
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
 * Cross-vendor judge panel. Different providers share none of each other's blind
 * spots, so a panel that spans vendors (e.g. OpenAI + Google + Anthropic) catches
 * more than any single judge — the "high-powered but different-provider judges"
 * design. Returns distinct slugs, none equal to the executor, from an explicit
 * `OXAGEN_JUDGE_PANEL` (comma-separated) or a sensible cross-vendor default.
 * Exported for tests.
 */
export function pickJudgePanel(executorModel: string, override?: string): string[] {
  const raw = override ?? process.env["OXAGEN_JUDGE_PANEL"];
  const explicit = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [DEFAULT_ADVISOR_MODEL, "google/gemini-2.5-pro", modelForTier("precise")];
  // Distinct, and never the executor (self-grading defeats the point).
  const seen = new Set<string>();
  const panel = explicit.filter((m) => m !== executorModel && !seen.has(m) && seen.add(m));
  // Guarantee at least one judge distinct from the executor.
  if (panel.length === 0) panel.push(pickAdvisorModel(executorModel));
  return panel;
}

/** Dedup a list of strings, preserving first-seen order. */
function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((s) => !seen.has(s) && seen.add(s));
}

/**
 * Run a PANEL of judges (distinct cross-vendor models) concurrently and
 * aggregate: the work is complete only if a MAJORITY say so; findings and
 * remaining work are the union across the dissenting judges; confidence is the
 * mean. A single judge failing degrades to its heuristic (handled inside
 * {@link judgeCompleteness}) rather than sinking the panel.
 */
export async function judgePanel(
  opts: JudgeOptions,
  ai: AgentAi,
  advisorModels?: string[],
): Promise<JudgeVerdict> {
  const models = dedup(advisorModels ?? pickJudgePanel(opts.executorModel));
  if (models.length <= 1) {
    return judgeCompleteness({ ...opts, advisorModel: models[0] }, ai);
  }
  const verdicts = await Promise.all(
    models.map((m) => judgeCompleteness({ ...opts, advisorModel: m }, ai)),
  );
  const completes = verdicts.filter((v) => v.complete).length;
  const complete = completes * 2 > verdicts.length; // strict majority
  const dissenting = verdicts.filter((v) => !v.complete);
  const findings = dedup(dissenting.flatMap((v) => v.findings));
  const remainingWork = dedup(dissenting.flatMap((v) => v.remainingWork));
  const confidence = Math.round(
    verdicts.reduce((s, v) => s + v.confidence, 0) / verdicts.length,
  );
  const usage = verdicts.reduce((acc, v) => accumulateUsage(acc, v.model, v.usage), emptyUsage());
  return {
    complete,
    confidence,
    findings: complete ? [] : findings,
    remainingWork: complete ? [] : remainingWork,
    reasoning:
      `Panel of ${verdicts.length} (${models.map((m) => m.split("/").pop()).join(", ")}): ` +
      `${completes}/${verdicts.length} judged complete. ` +
      dissenting.map((v) => `${v.model.split("/").pop()}: ${v.reasoning}`).join(" | "),
    model: `panel(${models.join(",")})`,
    fallback: verdicts.every((v) => v.fallback),
    usage,
  };
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
