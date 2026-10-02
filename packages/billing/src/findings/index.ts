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
 * The entries the caps keep, largest saving first: at most
 * `FINDINGS_PER_KIND` of each kind, then at most `room` in all.
 */
function withinCaps(entries: readonly Ranked[], room: number): Ranked[] {
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
    .slice(0, Math.max(room, 0));
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
 * A group frees the frames it claimed when the pass will not write it:
 * - `toDraft` drops it, because its saving is under a cent or its coverage
 *   is under half (#4607).
 * - The caps cut it, because it ranks past `FINDINGS_PER_KIND` of its kind
 *   or past the `room` left under `FINDINGS_MAX` (#5050). The group goes in
 *   `cut`, so the pass does not write it either.
 *
 * A later counting detector may then claim the freed frames. So a claimed
 * frame always belongs to a finding the pass writes, and the headline counts
 * it once. A group whose fingerprint is in `exempt` is never cut.
 *
 * Returns how many findings the detector keeps. Each one takes a place under
 * `FINDINGS_MAX`.
 */
function settle(
  d: Detector,
  ctx: DetectContext,
  windowEnd: Date,
  room: number,
  cut: Set<Group>,
  exempt: ReadonlySet<string> = new Set(),
): number {
  if (d.counting === null) return 0;
  const kinds = new Set<FindingKind>(d.kinds);
  const entries: Ranked[] = [];
  for (const group of ctx.groups.values()) {
    if (!kinds.has(group.kind)) continue;
    const draft = toDraft(group, windowEnd, NO_PROSE);
    if (draft === null) free(group, ctx);
    else entries.push({ group, draft });
  }
  const kept = new Set(withinCaps(entries, room).map((e) => e.group));
  let keeps = 0;
  for (const { group, draft } of entries) {
    if (kept.has(group) || exempt.has(draft.fingerprint)) keeps += 1;
    else {
      free(group, ctx);
      cut.add(group);
    }
  }
  return keeps;
}

/**
 * Every finding the window's runs, tool calls, and model calls prove,
 * largest saving first: at most `FINDINGS_PER_KIND` per kind and
 * `FINDINGS_MAX` in all.
 *
 * A finding that counts toward the unproductive spend headline takes its
 * place under `FINDINGS_MAX` first, in counting order, as its detector
 * finishes. The other findings fill the room left, largest saving first. So
 * the cap never drops a finding whose frames the headline counts (#5050).
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
  const cut = new Set<Group>();
  let room = FINDINGS_MAX;
  for (const d of detectors) {
    for (const kind of d.kinds) {
      prose.set(kind, d.prose);
      if (d.counting !== null) counting.add(kind);
    }
    d.detect(input, ctx);
    room -= settle(d, ctx, input.window.end, room, cut);
  }

  const kept: FindingDraft[] = [];
  const others: Ranked[] = [];
  for (const group of ctx.groups.values()) {
    if (cut.has(group)) continue;
    const draft = toDraft(group, input.window.end, prose.get(group.kind)!);
    if (draft === null) continue;
    // `settle` already capped the counting kinds.
    if (counting.has(draft.kind)) kept.push(draft);
    else others.push({ group, draft });
  }
  return [...kept, ...withinCaps(others, room).map((e) => e.draft)].sort(
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
 * Each detector's groups settle as they do in a pass: a group the pass would
 * not write, or would cut, frees its frames for the next detector (#5050).
 * A released group is never cut, so an applied finding keeps its claims
 * whatever the open findings rank.
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
  const cut = new Set<Group>();
  let room = FINDINGS_MAX;
  for (const d of detectors) {
    if (d.counting === null) continue;
    d.detect(replay, ctx);
    // A released group past the caps still keeps its place, so the room
    // can run out before every released group is counted.
    room = Math.max(
      0,
      room - settle(d, ctx, input.window.end, room, cut, released),
    );
  }
  const out = new Map<string, FindingClaim[]>();
  for (const group of ctx.groups.values())
    if (!cut.has(group) && group.claims.length > 0)
      out.set(
        findingFingerprint(group.kind, group.level, group.subject),
        group.claims,
      );
  return out;
}
