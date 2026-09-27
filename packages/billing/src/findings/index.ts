/**
 * The PURE findings detectors (Mission Control spec §12.8; ADR-062,
 * ADR-206). No I/O: ../findings-store.ts reads the run rows, the tool-call
 * frames, and the model-call frames, and writes `cost.findings` and
 * `cost.finding_claims`. This module is what the tests exercise.
 *
 * `DETECTORS` runs in order. A detector that claims frames goes in counting
 * order (1, then 7, then 8), so a frame counts under the first that claims
 * it. A detector registers here with one line and keeps its own module.
 */
import type { FindingKind } from "@oxagen/database/schema";
import { cacheWritesNeverRead } from "./cache-writes-never-read";
import { buildRunViews } from "./requests";
import { repeats } from "./repeats";
import {
  FINDINGS_MAX,
  FINDINGS_PER_KIND,
  Groups,
  toDraft,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingDraft,
  type Prose,
} from "./shared";
import { spinLoops } from "./spin-loops";
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

/** Every detector a pass runs, in the order it runs them. */
export const DETECTORS: readonly Detector[] = [
  spinLoops,
  repeats,
  cacheWritesNeverRead,
  unpagedResults,
];

/** The kinds the registered detectors write. */
export const DETECTED_KINDS: readonly FindingKind[] = DETECTORS.flatMap(
  (d) => d.kinds,
);

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
