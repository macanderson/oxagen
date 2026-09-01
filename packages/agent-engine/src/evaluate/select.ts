/**
 * Best-of-N selector — pick the winning candidate patch.
 *
 * Best-of-N runs the same task N times independently (in isolated workspaces)
 * and this stage chooses the one to keep. Comparative judging beats independent
 * scoring: one judge sees ALL candidates side by side — each candidate's real
 * `git diff` and the tail of its test output — and picks the one that actually
 * solves the task, preferring passing tests and the smallest correct change.
 *
 * Degrades gracefully: with 0 viable candidates the winner is null; with 1 it is
 * chosen without a model call; on a model failure a heuristic (tests-pass →
 * fewest-files → fewest-steps) selects, so a best-of-N run always resolves.
 */
import { z } from "zod";
import { accumulateUsage } from "../router/model-router";
import { emptyUsage, type UsageTotals } from "../types";
import { isFatalAuthOrBillingError } from "../model-errors";
import type { AgentAi } from "../ports";

/** One best-of-N candidate: the isolated turn's result, ready to compare. */
export interface Candidate {
  /** Stable id, e.g. "candidate-1". */
  id: string;
  /** Model that produced it (candidates may use a model-mix for diversity). */
  model: string;
  /** The candidate's `git diff` (the patch it would contribute). */
  diff: string;
  /** The agent's final message. */
  summary: string;
  /** Tail of the last test/command output the candidate ran, if any. */
  testOutput?: string;
  /**
   * Whether executed tests are known to have passed — set when a caller ran
   * REAL verification (a `verifyCommand` and/or best-of-N's `verifyAuto`
   * cross-candidate test-command union) and captured the exit code, rather
   * than inferred from `testOutput` text. `null`/undefined ⇒ unknown; the
   * selector falls back to sniffing `testOutput` (`looksPassing`) in that
   * case. This is the DECISIVE signal per SELECT_SYSTEM's rule 1 when present.
   */
  testsPassed?: boolean | null;
  /** Files the candidate changed. */
  changedFiles: string[];
  /** Tool-loop steps the candidate took. */
  steps: number;
  /** True when the candidate's turn errored out. */
  failed?: boolean;
}

export interface SelectionResult {
  /** The chosen candidate id, or null when none is viable. */
  winnerId: string | null;
  /** Why this candidate won (or why none did). */
  reasoning: string;
  /** Every candidate scored 0–100, best first. */
  ranking: Array<{ id: string; score: number; note: string }>;
  /** The selector model (or a heuristic label). */
  model: string;
  /** True when a heuristic chose (model unavailable / not needed). */
  fallback: boolean;
  usage: UsageTotals;
}

/**
 * The default best-of-N selector model. Same-vendor default (Fable 5) so it
 * works on an Anthropic-only key (the CLI's ANTHROPIC_API_KEY BYOK fallback
 * resolves no other vendor) — mirrors judge.ts's `DEFAULT_ADVISOR_MODEL` for
 * the same reason. Override per-call (`selectorModel`) or globally via
 * `OXAGEN_LLM_SELECTOR` (e.g. a cross-vendor slug, when a gateway key is
 * available and vendor-independent selection is preferred).
 */
export const DEFAULT_SELECTOR_MODEL = "anthropic/claude-fable-5";

/** Heuristic: does this command output look like tests PASSED (no failures)? */
export function looksPassing(output: string | undefined): boolean {
  if (!output) return false;
  return !/\b(fail(ed|ure)?|error|traceback|assert(ionerror)?|exit code [1-9]|\bE\d{3}\b)\b/i.test(
    output,
  );
}

/** A viable candidate: it didn't error and it produced a change (or ran commands). */
function isViable(c: Candidate): boolean {
  return !c.failed && (c.diff.trim().length > 0 || Boolean(c.testOutput));
}

function headTail(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.5);
  return `${s.slice(0, head)}\n… [${s.length - max} chars elided]\n${s.slice(s.length - (max - head))}`;
}

/** Score a candidate without a model: tests-pass, then small, then few steps. */
function heuristicScore(c: Candidate): number {
  let score = 40;
  // A verified testsPassed is a stronger signal than sniffing testOutput text
  // (looksPassing), so it takes priority when both are present.
  if (c.testsPassed != null) {
    score += c.testsPassed ? 40 : -20;
  } else if (c.testOutput) {
    score += looksPassing(c.testOutput) ? 40 : -20;
  }
  // Prefer a focused change over a sprawling one.
  score += Math.max(0, 15 - c.changedFiles.length * 3);
  if (c.diff.trim().length === 0) score = 5;
  return Math.max(0, Math.min(100, score));
}

/** One-phrase note explaining a candidate's test evidence, for the ranking. */
function testNote(c: Candidate): string {
  if (c.testsPassed != null)
    return c.testsPassed ? "tests verified passing" : "tests verified failing";
  if (c.testOutput)
    return looksPassing(c.testOutput)
      ? "tests appear to pass"
      : "tests appear to fail";
  return "no tests run";
}

function heuristicSelect(candidates: Candidate[]): SelectionResult {
  const ranking = candidates
    .map((c) => ({ id: c.id, score: heuristicScore(c), note: testNote(c) }))
    .sort((a, b) => b.score - a.score);
  const winner = ranking.find((r) => r.score > 5) ?? null;
  return {
    winnerId: winner?.id ?? null,
    reasoning: winner
      ? `Heuristic selection (no selector model): chose ${winner.id} (${winner.note}).`
      : "Heuristic selection: no candidate produced a viable change.",
    ranking,
    model: "heuristic",
    fallback: true,
    usage: emptyUsage(),
  };
}

const selectionSchema = z.object({
  winnerId: z
    .string()
    .describe(
      "The id of the single best candidate. Must be one of the given ids.",
    ),
  reasoning: z
    .string()
    .describe(
      "2–4 sentences: why this candidate wins, citing its diff and test output.",
    ),
  ranking: z
    .array(
      z.object({
        id: z.string(),
        score: z
          .number()
          .min(0)
          .max(100)
          .describe("How well this candidate solves the task."),
        note: z
          .string()
          .describe("One phrase: the deciding factor for this candidate."),
      }),
    )
    .describe("Every candidate, scored."),
});

const SELECT_SYSTEM = [
  "You are selecting the single best of several candidate patches that were each",
  "produced independently for the SAME coding task. Judge the EVIDENCE:",
  "1. TEST OUTPUT is decisive — a candidate whose tests pass beats one whose tests",
  "   fail or error, no matter how confident its summary.",
  "2. The DIFF must actually implement the request. An empty or off-target diff loses.",
  "3. Among candidates that pass, prefer the SMALLEST correct change (fewest files,",
  "   least incidental churn).",
  "Pick exactly one winner by id and score every candidate 0–100.",
].join("\n");

function candidateBlock(c: Candidate): string {
  const diff = c.diff.trim()
    ? "```diff\n" + headTail(c.diff, 6000) + "\n```"
    : "(empty diff)";
  const tests = c.testOutput ? headTail(c.testOutput, 2000) : "(no tests run)";
  // Spell out the verified verdict explicitly rather than leaving the model to
  // infer pass/fail from the raw text — makes rule 1 (test output is decisive)
  // unambiguous when a caller ran real verification (verifyCommand/verifyAuto).
  const testsLabel =
    c.testsPassed === true
      ? "test output (VERIFIED PASSING)"
      : c.testsPassed === false
        ? "test output (VERIFIED FAILING)"
        : "test output";
  return [
    `### ${c.id}  (model: ${c.model.split("/").pop()}, ${c.changedFiles.length} file(s), ${c.steps} step(s))`,
    `summary: ${c.summary || "(none)"}`,
    `${testsLabel}:\n${tests}`,
    `diff:\n${diff}`,
  ].join("\n");
}

/**
 * Choose the best candidate. Comparative model judging when >1 viable candidate;
 * otherwise trivial / heuristic. Never throws.
 */
export async function selectBestCandidate(opts: {
  request: string;
  candidates: Candidate[];
  ai: AgentAi;
  selectorModel?: string;
  signal?: AbortSignal;
}): Promise<SelectionResult> {
  const viable = opts.candidates.filter(isViable);

  if (viable.length === 0) {
    return {
      winnerId: null,
      reasoning: "No candidate produced a viable change.",
      ranking: opts.candidates.map((c) => ({
        id: c.id,
        score: 0,
        note: c.failed ? "errored" : "no change",
      })),
      model: "none",
      fallback: true,
      usage: emptyUsage(),
    };
  }
  if (viable.length === 1) {
    return {
      winnerId: viable[0]!.id,
      reasoning: `Only one candidate (${viable[0]!.id}) produced a viable change.`,
      ranking: [
        { id: viable[0]!.id, score: 100, note: "sole viable candidate" },
      ],
      model: "none",
      fallback: true,
      usage: emptyUsage(),
    };
  }

  const model =
    opts.selectorModel ??
    process.env["OXAGEN_LLM_SELECTOR"] ??
    DEFAULT_SELECTOR_MODEL;
  try {
    const { object, usage } = await opts.ai.generateObject({
      model,
      schema: selectionSchema,
      system: SELECT_SYSTEM,
      prompt: [
        `## Task\n${opts.request}`,
        `## Candidates (${viable.length})`,
        ...viable.map(candidateBlock),
        `\nReturn the winner id (one of: ${viable.map((c) => c.id).join(", ")}) and score every candidate.`,
      ].join("\n\n"),
      abortSignal: opts.signal,
    });
    // Guard the model's winnerId against the viable set; fall back to the
    // highest-ranked viable candidate if it named something invalid.
    const validWinner = viable.some((c) => c.id === object.winnerId)
      ? object.winnerId
      : ([...object.ranking]
          .sort((a, b) => b.score - a.score)
          .find((r) => viable.some((c) => c.id === r.id))?.id ?? viable[0]!.id);
    return {
      winnerId: validWinner,
      reasoning: object.reasoning,
      ranking: object.ranking,
      model,
      fallback: false,
      usage: accumulateUsage(emptyUsage(), model, usage),
    };
  } catch (err) {
    // A FATAL auth/billing error re-throws rather than falling back — every
    // other call this run would fail identically (see isFatalAuthOrBillingError).
    if (isFatalAuthOrBillingError(err)) throw err;
    return heuristicSelect(viable);
  }
}
