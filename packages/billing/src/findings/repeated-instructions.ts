/**
 * Prompt habits (detector 6): an instruction operators keep sending into
 * runs, where a steering record would reach every run it applies to with no
 * paste.
 *
 * On a `content_exact` workspace the detector splits each prompt into
 * sentences and matches them across runs. A sentence in `MIN_INSTRUCTION_RUNS`
 * or more runs is a repeated instruction, and ../findings-store.ts opens a
 * steering record proposal for each one (`instructionProposals`). On a
 * `digest_only` workspace the text is not stored, so the detector matches
 * whole prompts by `prompt_digest`, in `MIN_WHOLE_PROMPT_RUNS` or more runs,
 * and opens no proposal.
 *
 * A prompt that opens its run costs nothing here: the run needed a prompt.
 * A later prompt answers the turns since the run's previous prompt, so it is
 * priced at those turns' model-call frames, an upper bound. The finding
 * prices a part of the run and claims no frame, so it adds nothing to the
 * unproductive spend headline (ADR-208).
 */
import { createHash } from "node:crypto";
import type { CostBasis } from "@oxagen/database/schema";
import { foldBasis, type RunTotalsRecord } from "../cost-rollup";
import type { InstructionProposal } from "./proposal-opener";
import type { PromptRead, RunPrompt } from "./prompts";
import {
  agentOrOperator,
  FINDINGS_WINDOW_DAYS,
  plural,
  timeOf,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
  type Group,
  type Measure,
  type PricedRequestFrame,
} from "./shared";

const KIND = "repeated_instructions";

/** A sentence in this many runs or more is a repeated instruction. */
export const MIN_INSTRUCTION_RUNS = 3;
/** A whole prompt in this many runs or more is a whole-prompt repeat. */
export const MIN_WHOLE_PROMPT_RUNS = 2;
/** A sentence with fewer words than this ("yes", "go on") is not an instruction. */
const MIN_SENTENCE_WORDS = 4;
/** A whole prompt shorter than this is not an instruction either. */
const MIN_WHOLE_PROMPT_CHARS = 20;
/** A longer sentence is a pasted block, not an instruction. */
const MAX_SENTENCE_CHARS = 500;
/** The characters of a sentence a finding quotes. */
const QUOTE_CHARS = 160;
/** Proposals one pass opens, most repeated first. */
export const PROPOSALS_PER_PASS = 20;
/** The proposal contract's caps (`proposalSupportSchema`). */
const PROPOSAL_RUNS_MAX = 500;
const PROPOSAL_AGENTS_MAX = 100;
const PROPOSAL_LINKS_MAX = 100;

/** A prompt in its run's order. */
interface Placed {
  prompt: RunPrompt;
  /** The run's prompt before this one; null on the first prompt the pass read. */
  previous: RunPrompt | null;
}

/** A sentence, or a whole prompt, that more than one run received. */
export interface Repeat {
  /** The sentence's digest, or the whole prompt's `prompt_digest`. */
  digest: string;
  /** The sentence as the earliest run received it; null for a whole prompt. */
  text: string | null;
  /** Each prompt that carried it, in time order. */
  occurrences: Placed[];
  /** The runs those prompts went to. */
  runs: Set<string>;
}

function byTime(a: RunPrompt, b: RunPrompt): number {
  return (
    timeOf(a) - timeOf(b) ||
    (a.runId !== b.runId ? (a.runId < b.runId ? -1 : 1) : a.seq - b.seq)
  );
}

/** The window's prompts in time order, each with the run's prompt before it. */
function place(
  prompts: readonly RunPrompt[],
  runs: { has(runId: string): boolean },
): Placed[] {
  const byRun = new Map<string, RunPrompt[]>();
  for (const p of prompts) {
    if (!runs.has(p.runId)) continue;
    const list = byRun.get(p.runId) ?? [];
    list.push(p);
    byRun.set(p.runId, list);
  }
  const out: Placed[] = [];
  for (const list of byRun.values()) {
    list.sort(byTime);
    list.forEach((prompt, i) =>
      out.push({ prompt, previous: i === 0 ? null : list[i - 1]! }),
    );
  }
  return out.sort((a, b) => byTime(a.prompt, b.prompt));
}

/** A list marker or a quote marker at the start of a line. */
const LINE_MARKER = /^(?:[-*+>•]|\d+[.)])\s+/;

/**
 * The sentences of a prompt worth matching, each once. A sentence ends at a
 * line break or at `.`, `!`, or `?` before a space. Code fences are skipped,
 * and so are sentences under `MIN_SENTENCE_WORDS` words or over
 * `MAX_SENTENCE_CHARS` characters. The key is the sentence in lower case with
 * its closing punctuation dropped, so "Run the tests." and "run the tests"
 * match.
 */
export function sentencesOf(text: string): { key: string; text: string }[] {
  const seen = new Set<string>();
  const out: { key: string; text: string }[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const part of line.replace(LINE_MARKER, "").split(/(?<=[.!?])\s+/)) {
      const sentence = part.replace(/\s+/g, " ").trim();
      if (sentence.length === 0 || sentence.length > MAX_SENTENCE_CHARS)
        continue;
      const words = sentence.split(" ").filter((w) => /\p{L}/u.test(w));
      if (words.length < MIN_SENTENCE_WORDS) continue;
      const key = sentence.toLowerCase().replace(/[.!?;:,]+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, text: sentence });
    }
  }
  return out;
}

function sentenceDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * The sentences, or on a `digest_only` workspace the whole prompts, that
 * enough runs received, most repeated first.
 */
export function repeatsOf(
  read: Pick<PromptRead, "mode" | "prompts">,
  runs: { has(runId: string): boolean },
): Repeat[] {
  const byDigest = new Map<string, Repeat>();
  const note = (digest: string, text: string | null, p: Placed) => {
    let repeat = byDigest.get(digest);
    if (!repeat) {
      repeat = { digest, text, occurrences: [], runs: new Set() };
      byDigest.set(digest, repeat);
    }
    repeat.occurrences.push(p);
    repeat.runs.add(p.prompt.runId);
  };
  for (const p of place(read.prompts, runs)) {
    if (read.mode === "digest_only") {
      if (p.prompt.length === null || p.prompt.length >= MIN_WHOLE_PROMPT_CHARS)
        note(p.prompt.digest, null, p);
      continue;
    }
    if (p.prompt.text === null) continue;
    for (const s of sentencesOf(p.prompt.text))
      note(sentenceDigest(s.key), s.text, p);
  }
  const min =
    read.mode === "digest_only" ? MIN_WHOLE_PROMPT_RUNS : MIN_INSTRUCTION_RUNS;
  return [...byDigest.values()]
    .filter((r) => r.runs.size >= min)
    .sort(
      (a, b) =>
        b.occurrences.length - a.occurrences.length ||
        b.runs.size - a.runs.size ||
        (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0),
    );
}

/**
 * The runs whose prompts a finding would price: those with a repeat that
 * answers earlier turns, most such prompts first, at most `limit`. The store
 * reads model-call frames for these runs alone.
 */
export function promptRunsToPrice(
  read: Pick<PromptRead, "mode" | "prompts">,
  runs: { has(runId: string): boolean },
  limit: number,
): string[] {
  const counts = new Map<string, number>();
  for (const repeat of repeatsOf(read, runs))
    for (const o of repeat.occurrences)
      if (o.previous !== null)
        counts.set(o.prompt.runId, (counts.get(o.prompt.runId) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([runId]) => runId);
}

/**
 * Where a repeat is reported: the agent or operator every run it reached
 * names, or the workspace when those runs name more than one, or none.
 */
function keyOf(
  repeat: Repeat,
  runs: ReadonlyMap<string, RunTotalsRecord>,
): FindingKey {
  let key: FindingKey | null = null;
  let workspaceId = "";
  for (const runId of repeat.runs) {
    const run = runs.get(runId)!;
    workspaceId = run.workspaceId;
    const own = agentOrOperator(KIND, run);
    if (
      own === null ||
      (key !== null && (own.level !== key.level || own.subject !== key.subject))
    )
      return { kind: KIND, level: "workspace", subject: workspaceId };
    key = own;
  }
  return key ?? { kind: KIND, level: "workspace", subject: workspaceId };
}

const UNCOVERED: Measure = {
  measuredTokens: 0,
  counterfactualTokens: 0,
  micros: null,
};

/**
 * A prompt's price: nothing for the run's first prompt, and the priced
 * frames since the run's previous prompt for any later one. A run whose
 * frames were not read, or a span with an unpriced frame, is not covered.
 */
function promptMeasure(
  placed: Placed,
  frames: readonly PricedRequestFrame[] | undefined,
): Measure {
  if (placed.previous === null)
    return {
      measuredTokens: 0,
      counterfactualTokens: 0,
      micros: { measured: 0n, counterfactual: 0n },
    };
  if (frames === undefined) return UNCOVERED;
  const from = timeOf(placed.previous);
  const to = timeOf(placed.prompt);
  let micros = 0n;
  let tokens = 0;
  let basis: CostBasis | null = null;
  for (const f of frames) {
    const at = timeOf(f);
    if (at <= from || at >= to) continue;
    if (f.costMicros === null || f.basis === null) return UNCOVERED;
    micros += f.costMicros;
    tokens += f.tokens;
    basis = foldBasis(basis, f.basis);
  }
  return {
    measuredTokens: tokens,
    counterfactualTokens: 0,
    micros: { measured: micros, counterfactual: 0n },
    ...(basis === null ? {} : { basis }),
  };
}

/** One repeat as a group reports it: the prompts and runs the group admitted. */
interface Reported {
  repeat: Repeat;
  prompts: number;
  runs: Set<string>;
}

/** Each written group's repeats, most repeated first, for its prose. */
const reported = new WeakMap<Group, Reported[]>();

function detect(input: DetectInput, ctx: DetectContext): void {
  const read = input.prompts;
  if (read === undefined) return;
  const byKey = new Map<
    string,
    { cited: Set<RunPrompt>; repeats: Reported[] }
  >();
  for (const repeat of repeatsOf(read, ctx.runs)) {
    const key = keyOf(repeat, ctx.runs);
    const id = `${key.level}|${key.subject}`;
    let entry = byKey.get(id);
    if (!entry) {
      entry = { cited: new Set(), repeats: [] };
      byKey.set(id, entry);
    }
    const shown: Reported = { repeat, prompts: 0, runs: new Set() };
    for (const o of repeat.occurrences) {
      const run = ctx.runs.get(o.prompt.runId)!;
      if (!ctx.groups.admits(key, run)) continue;
      shown.prompts += 1;
      shown.runs.add(run.runId);
      // A prompt with two repeated sentences is priced once.
      if (entry.cited.has(o.prompt)) continue;
      entry.cited.add(o.prompt);
      ctx.groups.add(
        key,
        input.window.start,
        run,
        promptMeasure(o, read.frames.get(run.runId)),
        [{ seq: o.prompt.seq, sessionUuid: null }],
      );
    }
    if (shown.prompts > 0) entry.repeats.push(shown);
  }
  for (const group of ctx.groups.values()) {
    if (group.kind !== KIND) continue;
    const entry = byKey.get(`${group.level}|${group.subject}`);
    if (entry)
      reported.set(
        group,
        [...entry.repeats].sort(
          (a, b) => b.prompts - a.prompts || b.runs.size - a.runs.size,
        ),
      );
  }
}

/** A sentence cut to `QUOTE_CHARS` characters for a finding to quote. */
function quote(text: string): string {
  return text.length <= QUOTE_CHARS
    ? text
    : `${text.slice(0, QUOTE_CHARS - 1).trimEnd()}…`;
}

const STEERING_LINE =
  "A steering record would reach every run it applies to with no paste.";

/** The finding's text for one repeated instruction (spec, detector 6). */
function instructionLine(text: string, prompts: number): string {
  return `Runs received "${quote(text)}" ${plural(prompts, "time", "times")} this month. ${STEERING_LINE}`;
}

function prose(group: Group): { why: string; fix: string } {
  const repeats = reported.get(group) ?? [];
  const top = repeats[0];
  const others = repeats.length - 1;
  if (top !== undefined && top.repeat.text !== null)
    return {
      why:
        instructionLine(top.repeat.text, top.prompts) +
        (others > 0
          ? ` ${plural(others, "other instruction", "other instructions")} also reached ${MIN_INSTRUCTION_RUNS} or more runs.`
          : ""),
      fix: "Review the steering record proposal for this instruction on the Steering page. Once you publish it, every run it applies to receives it with no paste.",
    };
  return {
    why:
      (top === undefined
        ? "Runs received the same prompt more than once this month."
        : `Runs received the same prompt ${plural(top.prompts, "time", "times")} this month, across ${plural(top.runs.size, "run", "runs")}.`) +
      (others > 0
        ? ` ${plural(others, "other prompt", "other prompts")} also repeated.`
        : "") +
      " Needs prompt text: this workspace keeps only a digest of each prompt, so the sentences that repeat cannot be shown.",
    fix: "Keep prompt text for model calls in the workspace's retention policy. The next pass then shows the repeated sentences and proposes a steering record for each one.",
  };
}

export const repeatedInstructions: Detector = {
  kinds: [KIND],
  counting: null,
  detect,
  prose,
};

/**
 * One steering record proposal per repeated instruction, most repeated
 * first, at most `PROPOSALS_PER_PASS`. A `digest_only` workspace gets none,
 * because the text is not stored. The lineage id is the sentence's digest,
 * so the same instruction names the same lineage on every pass.
 */
export function instructionProposals(
  read: PromptRead | undefined,
  runs: readonly RunTotalsRecord[],
): InstructionProposal[] {
  if (read === undefined || read.mode !== "content_exact") return [];
  const byId = new Map(runs.map((r) => [r.runId, r]));
  return repeatsOf(read, byId)
    .slice(0, PROPOSALS_PER_PASS)
    .map((repeat) => {
      const runIds = [...repeat.runs].sort();
      const agents = [
        ...new Set(
          runIds
            .map((id) => byId.get(id)!.agentKey)
            .filter((k): k is string => k !== null),
        ),
      ].sort();
      return {
        lineageId: `ctx.habits.instruction-${repeat.digest.slice(0, 12)}`,
        statement: repeat.text!,
        rationale: `Runs received "${quote(repeat.text!)}" ${plural(repeat.occurrences.length, "time", "times")} in the last ${FINDINGS_WINDOW_DAYS} days, across ${plural(repeat.runs.size, "run", "runs")}. ${STEERING_LINE}`,
        runs: runIds.slice(0, PROPOSAL_RUNS_MAX),
        agents: agents.slice(0, PROPOSAL_AGENTS_MAX),
        evidenceLinks: repeat.occurrences
          .slice(0, PROPOSAL_LINKS_MAX)
          .map((o) => `frame:${o.prompt.runId}/${o.prompt.seq}`),
      };
    });
}
