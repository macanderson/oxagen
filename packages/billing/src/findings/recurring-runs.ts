/**
 * Recurring runs (detector 7, ADR-208): a job that sends the same prompt on a
 * clock, where a run that finds nothing to do still pays to find that out.
 * The detector groups the window's runs by the digest of their first prompt.
 * A group of `RECURRING_RUNS_MIN` or more runs is recurring. A run in it that
 * made no mutating call and changed no file changed nothing, and its whole
 * cost is unproductive.
 *
 * The finding prices each model-call frame of such a run whole, against
 * nothing, and claims it as detector 7. It runs after detector 1 and before
 * detector 8, so a frame spin loops claimed this pass is skipped here, and
 * spend with no outcome skips a frame this detector claimed. A run whose
 * frames were not read, or whose read found none, is cited and not priced.
 * A run whose rollup counted no model call spent nothing, so it is left out.
 *
 * A run that changed a file, or made a call the classifier marked mutating,
 * changed something and is left out. When neither is known, the run is cited
 * and not priced, since the pass cannot tell whether it changed anything:
 *
 * - It started before the tool-call read began (`toolWindowStart`).
 * - It had not sealed by the window's end, so it may still write.
 * - The read saw a different number of calls than its rollup counted.
 * - The classifier said nothing about one of its calls (`isMutating` null).
 * - The file change read has no entry for it.
 *
 * A ledger run records no prompt, so it is never grouped. On a harness that
 * does not report `prompt_source`, the digest is the only sign that runs come
 * from one job, as the detector 7 card notes.
 */
import type { RunTotalsRecord } from "../cost-rollup";
import { claimKey } from "./requests";
import {
  agentOrOperator,
  FINDINGS_WINDOW_DAYS,
  plural,
  requestMeasure,
  type ClaimOf,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
  type Group,
  type ToolCallObservation,
} from "./shared";

const KIND = "recurring_runs";

/** A prompt that starts this many runs or more is recurring. */
export const RECURRING_RUNS_MIN = 5;

/** What the pass can tell about a run's changes. */
export type RunChange = "changed" | "unchanged" | "unknown";

/**
 * Whether a run changed anything. A known change wins over every gap in the
 * reads: a run that changed a file, or made a mutating call, changed
 * something whatever else is unknown.
 */
export function runChange(
  run: RunTotalsRecord,
  calls: readonly ToolCallObservation[],
  input: DetectInput,
  fileChanges: ReadonlyMap<string, boolean>,
): RunChange {
  if (fileChanges.get(run.runId) === true) return "changed";
  if (calls.some((c) => c.isMutating === true)) return "changed";
  // The pass read calls from the tool-call window on, so a run that started
  // before it may have written in a call it never read.
  if (run.startedAt.getTime() < input.toolWindowStart.getTime())
    return "unknown";
  // A run still going may write later.
  if (run.sealedAt === null) return "unknown";
  if (run.sealedAt.getTime() >= input.window.end.getTime()) return "unknown";
  // The read skips a hook call with no tool name or input digest, and the
  // rollup counts it. The call the read skipped may have written.
  if (calls.length !== run.toolCalls) return "unknown";
  if (calls.some((c) => c.isMutating === null)) return "unknown";
  if (!fileChanges.has(run.runId)) return "unknown";
  return "unchanged";
}

/**
 * Where a recurring prompt is reported: the agent or operator every run it
 * started names, or the workspace when those runs name more than one, or
 * none. The subject stays a key the finding contract names, so one agent's
 * recurring prompts share one finding.
 */
function keyOf(runs: readonly RunTotalsRecord[]): FindingKey {
  let key: FindingKey | null = null;
  let workspaceId = "";
  for (const run of runs) {
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

/**
 * Cite an unchanged run: each of its frames no earlier detector claimed,
 * priced whole and claimed as detector 7. Returns whether the finding cites
 * the run.
 */
function citeUnchanged(
  key: FindingKey,
  run: RunTotalsRecord,
  input: DetectInput,
  ctx: DetectContext,
): boolean {
  const frames = input.frames?.get(run.runId);
  if (frames === undefined || frames.length === 0) {
    // The frames were not read, or the read missed the calls the rollup
    // counted: the run is cited, and nothing prices it.
    ctx.groups.add(key, input.window.start, run, requestMeasure(null), null);
    return true;
  }
  let cited = false;
  for (const frame of frames) {
    const claim = claimKey(run.runId, frame.key);
    if (ctx.claimed.has(claim)) continue;
    ctx.claimed.add(claim);
    const claimOf: ClaimOf = { detector: 7, frame };
    ctx.groups.add(
      key,
      input.window.start,
      run,
      requestMeasure(frame),
      null,
      claimOf,
    );
    cited = true;
  }
  return cited;
}

/** One recurring prompt as a finding reports it. */
interface Recurring {
  /** The runs the prompt started that the finding may cite. */
  runs: number;
  /** The runs among them that changed nothing, which the finding cites. */
  unchanged: number;
}

/** Most unchanged runs first, then most runs. */
function byUnchanged(a: Recurring, b: Recurring): number {
  return b.unchanged - a.unchanged || b.runs - a.runs;
}

/** Each group's recurring prompts, in `byUnchanged` order, for its prose. */
const reported = new WeakMap<Group, Recurring[]>();

function detect(input: DetectInput, ctx: DetectContext): void {
  const { firstPrompts, fileChanges } = input;
  if (firstPrompts === undefined || fileChanges === undefined) return;
  const byDigest = new Map<string, RunTotalsRecord[]>();
  for (const run of input.runs) {
    const prompt = firstPrompts.get(run.runId);
    if (prompt === undefined) continue;
    const list = byDigest.get(prompt.digest) ?? [];
    list.push(run);
    byDigest.set(prompt.digest, list);
  }
  const callsByRun = new Map<string, ToolCallObservation[]>();
  for (const call of input.toolCalls) {
    const list = callsByRun.get(call.runId) ?? [];
    list.push(call);
    callsByRun.set(call.runId, list);
  }

  const byKey = new Map<string, Recurring[]>();
  for (const runs of byDigest.values()) {
    const key = keyOf(runs);
    // A decided finding comes back only when the job starts
    // `RECURRING_RUNS_MIN` more runs after the decision.
    const admitted = runs.filter((r) => ctx.groups.admits(key, r));
    if (admitted.length < RECURRING_RUNS_MIN) continue;
    const quiet: RunTotalsRecord[] = [];
    const unknown: RunTotalsRecord[] = [];
    for (const run of admitted) {
      // The rollup counted no model call, so the run spent nothing. Citing it
      // would add an unpriced item and pull the group's coverage down.
      if (run.modelCalls === 0) continue;
      const change = runChange(
        run,
        callsByRun.get(run.runId) ?? [],
        input,
        fileChanges,
      );
      if (change === "unchanged") quiet.push(run);
      else if (change === "unknown") unknown.push(run);
    }
    let unchanged = 0;
    for (const run of quiet)
      if (citeUnchanged(key, run, input, ctx)) unchanged += 1;
    // A prompt with no run cited as unchanged adds nothing. Its unknown runs
    // would otherwise join another prompt's finding under the same key, pull
    // its coverage down, and go unnamed in its prose.
    if (unchanged === 0) continue;
    for (const run of unknown)
      ctx.groups.add(key, input.window.start, run, requestMeasure(null), null);
    const id = `${key.level}|${key.subject}`;
    const list = byKey.get(id) ?? [];
    list.push({ runs: admitted.length, unchanged });
    byKey.set(id, list);
  }
  for (const group of ctx.groups.values()) {
    if (group.kind !== KIND) continue;
    const list = byKey.get(`${group.level}|${group.subject}`);
    if (list === undefined) continue;
    reported.set(group, [...list].sort(byUnchanged));
  }
}

function prose(group: Group): { why: string; fix: string } {
  const list = reported.get(group) ?? [];
  const top = list[0];
  const rest = list.slice(1);
  const restUnchanged = rest.reduce((sum, r) => sum + r.unchanged, 0);
  const lead =
    top === undefined
      ? `Runs started with the same prompt ${RECURRING_RUNS_MIN} or more times in the last ${FINDINGS_WINDOW_DAYS} days, and some of them changed nothing.`
      : `${plural(top.runs, "run", "runs")} started with the same prompt in the last ${FINDINGS_WINDOW_DAYS} days. ${top.unchanged.toLocaleString("en-US")} of them changed nothing.`;
  const more =
    rest.length === 0
      ? ""
      : ` ${plural(rest.length, "other prompt", "other prompts")} also started ${RECURRING_RUNS_MIN} or more runs each, and ${plural(restUnchanged, "run", "runs")} of those changed nothing.`;
  return {
    why: `${lead}${more} A run changed nothing when it made no mutating call and changed no file.`,
    fix: "Start the job on a change, such as a new commit or a new issue, instead of on a clock. If it must run on a clock, run it less often or move it to a smaller model class. If it calls the model API directly and can wait, send it as a batch at half price.",
  };
}

export const recurringRuns: Detector = {
  kinds: [KIND],
  counting: 7,
  detect,
  prose,
};
