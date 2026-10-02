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
  instructionProposals,
  MIN_INSTRUCTION_RUNS,
  MIN_WHOLE_PROMPT_RUNS,
  PROPOSALS_PER_PASS,
  promptRunsToPrice,
  repeatsOf,
  sentencesOf,
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

/**
 * Free the frames a counting detector claimed for a group that `toDraft`
 * will not write: one whose saving is under a cent, or whose coverage is
 * under half. A later counting detector may then claim them, so spend that
 * one detector could not write stays in the headline under the next (#4607).
 * Runs after each detector, before the next one reads `ctx.claimed`. Every
 * group of the detector's kinds is final by then, since no other detector
 * writes those kinds.
 */
function releaseUnwritten(
  d: Detector,
  ctx: DetectContext,
  windowEnd: Date,
): void {
  if (d.counting === null) return;
  const kinds = new Set<FindingKind>(d.kinds);
  for (const group of ctx.groups.values()) {
    if (!kinds.has(group.kind)) continue;
    if (toDraft(group, windowEnd, NO_PROSE) !== null) continue;
    for (const f of group.claimedFrames ?? [])
      ctx.claimed.delete(claimKey(f.runId, f.frameKey));
    group.claimedFrames = [];
  }
}

/**
 * Every finding the window's runs, tool calls, and model calls prove,
 * largest saving first: at most `FINDINGS_PER_KIND` per kind and
 * `FINDINGS_MAX` in all.
 */
export function detectFindings(input: DetectInput): FindingDraft[] {
  const runs = new Map(input.runs.map((r) => [r.runId, r]));
  const ctx: DetectContext = {
    groups: new Groups(input.decidedSince),
    runs,
    views: buildRunViews(input, runs),
    claimed: new Set(),
    taken: new Set(),
  };
  const prose = new Map<FindingKind, Prose>();
  for (const d of DETECTORS) {
    for (const kind of d.kinds) prose.set(kind, d.prose);
    d.detect(input, ctx);
    releaseUnwritten(d, ctx, input.window.end);
  }

  const byKind = new Map<FindingKind, FindingDraft[]>();
  for (const group of ctx.groups.values()) {
    const draft = toDraft(group, input.window.end, prose.get(group.kind)!);
    if (!draft) continue;
    const list = byKind.get(draft.kind) ?? [];
    list.push(draft);
    byKind.set(draft.kind, list);
  }
  const bySaving = (a: FindingDraft, b: FindingDraft) =>
    a.savingMicros > b.savingMicros
      ? -1
      : a.savingMicros < b.savingMicros
        ? 1
        : a.fingerprint < b.fingerprint
          ? -1
          : 1;
  return [...byKind.values()]
    .flatMap((list) => list.sort(bySaving).slice(0, FINDINGS_PER_KIND))
    .sort(bySaving)
    .slice(0, FINDINGS_MAX);
}

/**
 * The frames each fingerprint's finding claims when the decisions on the
 * `released` fingerprints are set aside, so a pass can give an applied
 * finding with no claim rows the frames it priced (#4506). Only the counting
 * detectors run, in counting order, so a frame is claimed under the first
 * detector that claims it, as in a pass. No cap applies: an applied finding
 * keeps its claims whatever the open findings rank.
 */
export function replayClaims(
  input: DetectInput,
  released: ReadonlySet<string>,
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
  for (const d of DETECTORS) {
    if (d.counting === null) continue;
    d.detect(replay, ctx);
    // As in a pass, so a later detector claims what an unwritten group freed.
    releaseUnwritten(d, ctx, input.window.end);
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
