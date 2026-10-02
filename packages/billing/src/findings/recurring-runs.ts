/**
 * Recurring runs (detector 7, ADR-208): a job that sends the same prompt on a
 * clock, where a run that finds nothing to do still pays to find that out.
 * The detector groups the window's runs by their first prompt: its digest,
 * and its source and origin where the recorder reports them (`jobOf`). A
 * group of `RECURRING_RUNS_MIN` or more runs is recurring. A run in it that
 * made no mutating call and changed no file changed nothing, and its whole
 * cost is unproductive.
 *
 * The finding prices each model-call frame of such a run whole, against
 * nothing, and claims it as detector 7. It runs after detector 1 and before
 * detector 8, so a frame spin loops claimed this pass is skipped here, and
 * spend with no outcome skips a frame this detector claimed. When the pass
 * does not write the finding, it frees those frames for detector 8. Each
 * model call the rollup counted and the read did not return is cited and not
 * priced: every call of a run the frame cap left unread, and each call a
 * short read missed. A run whose rollup counted no model call spent nothing,
 * so it is left out.
 *
 * A run that changed a file, or made a call the classifier marked mutating,
 * changed something and is left out. When neither is known, each of the
 * run's model calls is cited and not priced, since the pass cannot tell
 * whether the run changed anything:
 *
 * - It started before the tool-call read began (`toolWindowStart`).
 * - It had not sealed by the window's end, so it may still write.
 * - The read saw a different number of calls than its rollup counted.
 * - The classifier said nothing about one of its calls (`isMutating` null).
 * - The file change read has no entry for it.
 *
 * A ledger run records no prompt, so it is never grouped. A prompt a person
 * sent came from no clock, so its run is never grouped either. The origin
 * says who sent it when the recorder reports one: kind `human` is a person.
 * With no origin, the source `typed` or `queued` is a person. On a harness
 * that reports neither, the digest is the only sign that runs come from one
 * job, as the detector 7 card notes.
 *
 * A person's decision on a finding covers the runs it cited. Those runs set
 * no later finding's key, so a run from another agent cannot reopen them
 * under the workspace (`decidedUntil`).
 */
import type { RunTotalsRecord } from "../cost-rollup";
import { claimKey } from "./requests";
import {
  agentOrOperator,
  findingFingerprint,
  FINDINGS_WINDOW_DAYS,
  plural,
  requestMeasure,
  type ClaimOf,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
  type FindingValues,
  type Group,
  type RunFirstPrompt,
  type ToolCallObservation,
} from "./shared";

const KIND = "recurring_runs";

/** A prompt that starts this many runs or more is recurring. */
export const RECURRING_RUNS_MIN = 5;

/**
 * The `prompt_source` values of a prompt a person sent, read when the prompt
 * has no origin: `typed` (Claude Code, and Tacho on Codex), and `queued`, a
 * prompt typed while the agent was busy.
 */
const PERSON_SOURCES: ReadonlySet<string> = new Set(["typed", "queued"]);

/**
 * The origin kind of a prompt a person sent. Claude Code writes it on every
 * entrypoint, including Claude Desktop's Code tab, where the source is `sdk`
 * whoever sent the prompt.
 */
const PERSON_ORIGIN = "human";

/**
 * The `kind` an origin names. `RunFirstPrompt.origin` holds the origin as
 * JSON text, such as `{"kind":"human"}`. Text that does not parse, or names
 * no kind, reads as no origin.
 */
export function originKind(origin: string | null): string | null {
  if (origin === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(origin);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const kind = (parsed as { kind?: unknown }).kind;
  return typeof kind === "string" && kind !== "" ? kind : null;
}

/**
 * Whether a person sent the prompt: by its origin, or by its source when it
 * has no origin.
 */
function fromPerson(prompt: RunFirstPrompt): boolean {
  const kind = originKind(prompt.origin);
  if (kind !== null) return kind === PERSON_ORIGIN;
  return prompt.source !== null && PERSON_SOURCES.has(prompt.source);
}

/**
 * The job a run's first prompt names, or null for a prompt a person sent.
 * One prompt sent by an SDK and by a hook, or from two origins, names two
 * jobs. A recorder that reports neither field leaves the digest alone to name
 * the job.
 */
function jobOf(prompt: RunFirstPrompt): string | null {
  if (fromPerson(prompt)) return null;
  return JSON.stringify([prompt.digest, prompt.source, prompt.origin]);
}

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

/** One decision on a recurring runs finding, in time order. */
interface Decision {
  fingerprint: string;
  at: number;
}

/** The pass's decisions on recurring runs findings, earliest first. */
function decisionsOf(decidedSince: ReadonlyMap<string, Date>): Decision[] {
  return [...decidedSince]
    .filter(([fingerprint]) => fingerprint.startsWith(`${KIND}|`))
    .map(([fingerprint, at]) => ({ fingerprint, at: at.getTime() }))
    .sort((a, b) => a.at - b.at);
}

/**
 * When the latest decision that covers a job's runs was made, in
 * milliseconds; -Infinity when none covers them. A decision covers the runs
 * that started at or before it when those runs name its finding's key: the
 * runs past the previous covering decision, keyed as `keyOf` keys them. The
 * runs it covers then set no later key, so a run from a second agent cannot
 * move them to the workspace and bring them back.
 */
function decidedUntil(
  runs: readonly RunTotalsRecord[],
  decisions: readonly Decision[],
): number {
  let until = -Infinity;
  for (const d of decisions) {
    const before = runs.filter((r) => {
      const at = r.startedAt.getTime();
      return at > until && at <= d.at;
    });
    if (before.length === 0) continue;
    const key = keyOf(before);
    if (findingFingerprint(key.kind, key.level, key.subject) === d.fingerprint)
      until = d.at;
  }
  return until;
}

/**
 * Cite one run under a key. Each of its frames no earlier detector claimed
 * is cited. For a run that changed nothing, the caller passes `providers`:
 * each frame is priced whole and claimed as detector 7, and the provider of
 * each priced frame is added to the set. For a run whose change is unknown,
 * the caller passes null, and each frame is cited unpriced and left
 * unclaimed. Then each model call the rollup counted past the frames the read
 * returned is cited unpriced, so a run of 100 calls weighs 100 items in the
 * coverage, not one. Returns whether the finding cites the run.
 */
function cite(
  key: FindingKey,
  run: RunTotalsRecord,
  input: DetectInput,
  ctx: DetectContext,
  providers: Set<string | null> | null,
): boolean {
  // A run absent here was not read: the frame cap left it out, or it has no
  // frame source.
  const frames = input.frames?.get(run.runId) ?? [];
  let cited = false;
  for (const frame of frames) {
    const claim = claimKey(run.runId, frame.key);
    if (ctx.claimed.has(claim)) continue;
    cited = true;
    if (providers === null) {
      ctx.groups.add(key, input.window.start, run, requestMeasure(null), null);
      continue;
    }
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
    if (frame.costMicros !== null && frame.basis !== null)
      providers.add(frame.provider ?? null);
  }
  // A frame an earlier detector claimed was read, so it is not missing. A
  // read with more frames than the rollup counted adds none.
  for (let i = frames.length; i < run.modelCalls; i += 1) {
    ctx.groups.add(key, input.window.start, run, requestMeasure(null), null);
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

/** What a group's prose reads. */
interface Report {
  /** The group's recurring prompts, in `byUnchanged` order. */
  prompts: Recurring[];
  /** The providers the priced frames name; null for a frame that names none. */
  providers: Set<string | null>;
}

function emptyReport(): Report {
  return { prompts: [], providers: new Set() };
}

/** Each group's report, for its prose. */
const reported = new WeakMap<Group, Report>();

/**
 * The providers whose batch API is known to charge half the standard price.
 * The fix names that discount only when every priced frame of the finding
 * names one of them. Another provider, such as an `openai_compatible`
 * endpoint, may offer no batch API or a different rate.
 */
export const HALF_PRICE_BATCH_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
]);

/** Whether every priced frame names a provider with a half-price batch rate. */
function halfPriceBatch(providers: ReadonlySet<string | null>): boolean {
  if (providers.size === 0) return false;
  for (const p of providers)
    if (p === null || !HALF_PRICE_BATCH_PROVIDERS.has(p.toLowerCase()))
      return false;
  return true;
}

function detect(input: DetectInput, ctx: DetectContext): void {
  const { firstPrompts, fileChanges } = input;
  if (firstPrompts === undefined || fileChanges === undefined) return;
  const byJob = new Map<string, RunTotalsRecord[]>();
  for (const run of input.runs) {
    const prompt = firstPrompts.get(run.runId);
    if (prompt === undefined) continue;
    const job = jobOf(prompt);
    if (job === null) continue;
    const list = byJob.get(job) ?? [];
    list.push(run);
    byJob.set(job, list);
  }
  const callsByRun = new Map<string, ToolCallObservation[]>();
  for (const call of input.toolCalls) {
    const list = callsByRun.get(call.runId) ?? [];
    list.push(call);
    callsByRun.set(call.runId, list);
  }
  const decisions = decisionsOf(input.decidedSince);

  const byKey = new Map<string, Report>();
  for (const runs of byJob.values()) {
    // A decided finding comes back only when the job starts
    // `RECURRING_RUNS_MIN` more runs after the decision, and the runs it
    // covered do not choose the key those later runs are reported under.
    const until = decidedUntil(runs, decisions);
    const open = runs.filter((r) => r.startedAt.getTime() > until);
    if (open.length < RECURRING_RUNS_MIN) continue;
    const key = keyOf(open);
    const admitted = open.filter((r) => ctx.groups.admits(key, r));
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
    const id = `${key.level}|${key.subject}`;
    const report = byKey.get(id) ?? emptyReport();
    let unchanged = 0;
    for (const run of quiet)
      if (cite(key, run, input, ctx, report.providers)) unchanged += 1;
    // A prompt with no run cited as unchanged adds nothing. Its unknown runs
    // would otherwise join another prompt's finding under the same key, pull
    // its coverage down, and go unnamed in its prose.
    if (unchanged === 0) continue;
    for (const run of unknown) cite(key, run, input, ctx, null);
    report.prompts.push({ runs: admitted.length, unchanged });
    byKey.set(id, report);
  }
  for (const group of ctx.groups.values()) {
    if (group.kind !== KIND) continue;
    const report = byKey.get(`${group.level}|${group.subject}`);
    if (report === undefined) continue;
    reported.set(group, {
      prompts: [...report.prompts].sort(byUnchanged),
      providers: report.providers,
    });
  }
}

function prose(group: Group): {
  why: string;
  fix: string;
  values?: FindingValues;
} {
  const report = reported.get(group);
  const list = report?.prompts ?? [];
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
  const batch =
    report !== undefined && halfPriceBatch(report.providers)
      ? "send it as a batch at half price"
      : "send it as a batch, if its provider offers a batch API";
  return {
    why: `${lead}${more} A run changed nothing when it made no mutating call and changed no file.`,
    fix: `Start the job on a change, such as a new commit or a new issue, instead of on a clock. If it must run on a clock, run it less often or move it to a smaller model class. If it calls the model API directly and can wait, ${batch}.`,
    // The card names the top prompt's group; with none, it shows this text.
    ...(top === undefined
      ? {}
      : {
          values: {
            kind: KIND,
            groupSize: top.runs,
            unchanged: top.unchanged,
            otherPrompts: rest.length,
          },
        }),
  };
}

export const recurringRuns: Detector = {
  kinds: [KIND],
  counting: 7,
  detect,
  prose,
};
