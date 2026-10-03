/**
 * The PURE findings detectors (Mission Control spec §12.8; ADR-062,
 * ADR-208). No I/O: ../findings-store.ts reads the run rows, the tool-call
 * frames, and the model-call frames, and writes `cost.findings` and
 * `cost.finding_claims`. This module is what the tests exercise.
 *
 * `DETECTORS` runs in order. A detector that claims frames goes in counting
 * order (1, then 7, then 8), so a frame counts under the first that claims
 * it. A detector registers here with one line and keeps its own module.
 */
import type { FindingKind } from "@oxagen/database/schema";
import { cacheBusts } from "./cache-busts";
import { idleCacheRewrites } from "./cache-expiry";
import { cacheWritesNeverRead } from "./cache-writes-never-read";
import { modelClassFit } from "./model-class-fit";
import { recurringRuns } from "./recurring-runs";
import { buildRunViews, claimKey } from "./requests";
import { repeatedInstructions } from "./repeated-instructions";
import { repeats } from "./repeats";
import { retryLoops } from "./retry-loops";
import {
  findingFingerprint,
  FINDINGS_MAX,
  FINDINGS_PER_KIND,
  Groups,
  toDraft,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingClaim,
  type FindingDraft,
  type Group,
  type Prose,
} from "./shared";
import { spendWithNoOutcome } from "./spend-with-no-outcome";
import { spinLoops } from "./spin-loops";
import { standingContext } from "./standing-context";
import { unpagedResults } from "./unpaged-results";

export * from "./shared";
export { countClaims, type ClaimRow, type UnproductiveSpend } from "./claims";
export {
  runsWithRepeats,
  type RunRequest,
  type RunView,
  type ViewCall,
} from "./requests";
export { SPIN_LOOP_REPEATS, spinCalls } from "./spin-loops";
export { RETRY_LOOP_CALLS, retryCalls, runsWithRetries } from "./retry-loops";
export {
  instructionLineage,
  instructionProposals,
  MIN_INSTRUCTION_RUNS,
  MIN_WHOLE_PROMPT_RUNS,
  PROPOSALS_PER_PASS,
  promptRunsToPrice,
  repeatsOf,
  sentencesOf,
  type InstructionProposalLimits,
} from "./repeated-instructions";
export type { PromptRead, PromptTextMode, RunPrompt } from "./prompts";
export {
  chainVerdicts,
  MIN_QUOTE_CHARS,
  resultUseKey,
  type ChainFrame,
  type ResultTextMode,
  type ResultUseRead,
  type ResultVerdict,
} from "./result-use";
export { CARRY_RESULT_TOKENS, resultsToCheck } from "./unpaged-results";
export {
  setSpendProposalOpener,
  spendProposalOpener,
  type InstructionProposal,
  type SpendProposalInput,
  type SpendProposalOpener,
  type SpendProposalScope,
} from "./proposal-opener";

/** Every detector a pass runs, in the order it runs them. */
export const DETECTORS: readonly Detector[] = [
  spinLoops,
  retryLoops,
  repeats,
  recurringRuns,
  spendWithNoOutcome,
  cacheWritesNeverRead,
  idleCacheRewrites,
  cacheBusts,
  unpagedResults,
  standingContext,
  modelClassFit,
  repeatedInstructions,
];

/** The kinds the registered detectors write. */
export const DETECTED_KINDS: readonly FindingKind[] = DETECTORS.flatMap(
  (d) => d.kinds,
);

const NO_PROSE: Prose = () => ({ why: "", fix: "" });

/** Largest saving first. Equal savings order by fingerprint. */
function bySaving(a: FindingDraft, b: FindingDraft): number {
  return a.savingMicros > b.savingMicros
    ? -1
    : a.savingMicros < b.savingMicros
      ? 1
      : a.fingerprint < b.fingerprint
        ? -1
        : 1;
}

/** A group with the draft it would write. */
interface Ranked {
  group: Group;
  draft: FindingDraft;
}

/**
 * The advisory findings the caps keep, largest saving first: at most
 * `FINDINGS_PER_KIND` of each kind, then at most `FINDINGS_MAX` in all. A
 * counting finding never comes here (#5262).
 */
function withinCaps(entries: readonly Ranked[]): Ranked[] {
  const order = (a: Ranked, b: Ranked) => bySaving(a.draft, b.draft);
  const byKind = new Map<FindingKind, Ranked[]>();
  for (const e of entries) {
    const list = byKind.get(e.draft.kind) ?? [];
    list.push(e);
    byKind.set(e.draft.kind, list);
  }
  return [...byKind.values()]
    .flatMap((list) => list.sort(order).slice(0, FINDINGS_PER_KIND))
    .sort(order)
    .slice(0, FINDINGS_MAX);
}

/** Free every frame a group claimed, so a later counting detector may claim it. */
function free(group: Group, ctx: DetectContext): void {
  for (const f of group.claimedFrames ?? [])
    ctx.claimed.delete(claimKey(f.runId, f.frameKey));
  group.claimedFrames = [];
}

/**
 * Settle a counting detector's groups as soon as it finishes, before the
 * next detector reads `ctx.claimed`. Every group of the detector's kinds is
 * final by then, since no other detector writes those kinds.
 *
 * A group the pass will not write frees the frames it claimed, so a later
 * counting detector may claim them. The pass drops a group only when
 * `toDraft` does: its saving is under a cent, or its coverage is under half
 * (#4607). The caps never cut a counting group (#5262), so every group
 * `toDraft` keeps is written, and a claimed frame always belongs to a stored
 * finding. The headline then equals the sum of the findings behind it.
 */
function settle(d: Detector, ctx: DetectContext, windowEnd: Date): void {
  if (d.counting === null) return;
  const kinds = new Set<FindingKind>(d.kinds);
  for (const group of ctx.groups.values())
    if (kinds.has(group.kind) && toDraft(group, windowEnd, NO_PROSE) === null)
      free(group, ctx);
}

/**
 * Every finding the window's runs, tool calls, and model calls prove,
 * largest saving first.
 *
 * Every finding that counts toward the unproductive spend headline is
 * written, however many there are, so the headline counts every frame it
 * claims (#5262). The caps apply to the advisory findings alone, which count
 * toward nothing: at most `FINDINGS_PER_KIND` of each advisory kind and
 * `FINDINGS_MAX` in all, largest saving first. The counting findings take
 * none of that room, so a workspace with many agents still sees its
 * advisory findings.
 *
 * `detectors` is `DETECTORS` in a pass. A test may pass its own.
 */
export function detectFindings(
  input: DetectInput,
  detectors: readonly Detector[] = DETECTORS,
): FindingDraft[] {
  const runs = new Map(input.runs.map((r) => [r.runId, r]));
  const ctx: DetectContext = {
    groups: new Groups(input.decidedSince),
    runs,
    views: buildRunViews(input, runs),
    claimed: new Set(),
    taken: new Set(),
  };
  const prose = new Map<FindingKind, Prose>();
  const counting = new Set<FindingKind>();
  for (const d of detectors) {
    for (const kind of d.kinds) {
      prose.set(kind, d.prose);
      if (d.counting !== null) counting.add(kind);
    }
    d.detect(input, ctx);
    settle(d, ctx, input.window.end);
  }

  const kept: FindingDraft[] = [];
  const advisory: Ranked[] = [];
  for (const group of ctx.groups.values()) {
    const draft = toDraft(group, input.window.end, prose.get(group.kind)!);
    if (draft === null) continue;
    if (counting.has(draft.kind)) kept.push(draft);
    else advisory.push({ group, draft });
  }
  return [...kept, ...withinCaps(advisory).map((e) => e.draft)].sort(
    bySaving,
  );
}

/**
 * The frames each fingerprint's finding claims when the decisions on the
 * `released` fingerprints are set aside, so a pass can give an applied
 * finding with no claim rows the frames it priced (#4506). Only the counting
 * detectors run, in counting order, so a frame is claimed under the first
 * detector that claims it, as in a pass.
 *
 * Each detector's groups settle as they do in a pass: a group `toDraft`
 * drops frees its frames for the next detector. No cap cuts a counting group
 * in a pass or here (#5262), so the replay keeps the claims of every
 * counting group the pass keeps, under the same detectors.
 */
export function replayClaims(
  input: DetectInput,
  released: ReadonlySet<string>,
  detectors: readonly Detector[] = DETECTORS,
): Map<string, FindingClaim[]> {
  const decidedSince = new Map(
    [...input.decidedSince].filter(([fp]) => !released.has(fp)),
  );
  const replay: DetectInput = { ...input, decidedSince };
  const runs = new Map(input.runs.map((r) => [r.runId, r]));
  const ctx: DetectContext = {
    groups: new Groups(decidedSince),
    runs,
    views: buildRunViews(replay, runs),
    claimed: new Set(),
    taken: new Set(),
  };
  for (const d of detectors) {
    if (d.counting === null) continue;
    d.detect(replay, ctx);
    settle(d, ctx, input.window.end);
  }
  const out = new Map<string, FindingClaim[]>();
  for (const group of ctx.groups.values())
    if (group.claims.length > 0)
      out.set(
        findingFingerprint(group.kind, group.level, group.subject),
        group.claims,
      );
  return out;
}
