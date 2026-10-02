/**
 * shared.ts — the types, limits, and arithmetic every findings detector uses
 * (Mission Control spec §12.8; ADR-062, ADR-208). No I/O: ../findings-store.ts
 * reads the run rows, the tool-call frames, and the model-call frames, and
 * writes `cost.findings` and `cost.finding_claims`.
 *
 * A finding is a specific, costed problem over the runs it cites. Its saving
 * is measured minus counterfactual over those runs. A detector that prices a
 * part of a request (a result, a cache write) re-prices tokens at the run's
 * own input price. A detector that prices a whole request (a spin loop, a
 * turn of repeats) takes the request's own priced cost, and claims its frame
 * so the headline counts it once (ADR-208). A call or request with no price
 * is cited but not covered. Confidence is the share of cited items the
 * counterfactual covers, and a group whose coverage is under half is not
 * written.
 */
import type {
  CostBasis,
  FindingConfidence,
  FindingKind,
  FindingLevel,
} from "@oxagen/database/schema";
import { FINDING_FRAMES_PER_RUN } from "@oxagen/oxagen/contracts/finding.shared";
import {
  foldBasis,
  priceInputTokens,
  runInputPrice,
  type RunTotalsRecord,
} from "../cost-rollup";
import type { PromptRead } from "./prompts";
import type { TokenCounts } from "../cost-rollup";
import type { PriceEntry } from "../price-book";
import type { OutcomeRow } from "../run-pr-outcomes";
import type { RunView } from "./requests";

/** The most cited frames a finding stores per run; the contract's own cap (#4001). */
export { FINDING_FRAMES_PER_RUN };

/** The trailing window one pass reads. */
export const FINDINGS_WINDOW_DAYS = 30;
/** A result above this many tokens is unpaged. */
export const UNPAGED_RESULT_TOKENS = 20_000;
/** The page an unpaged result is re-priced at. */
export const PAGE_TOKENS = 4_000;
/** A finding saves at least one cent, or it is not written. */
export const MIN_SAVING_MICROS = 10_000n;
/** Coverage at or above this is `high`; below it, `medium`. */
const HIGH_CONFIDENCE_COVERAGE = 0.9;
/** Coverage below this is not written. */
const MIN_COVERAGE = 0.5;
/** Findings kept per kind, largest saving first. */
export const FINDINGS_PER_KIND = 10;
/**
 * Open findings one pass keeps, largest saving first: `list_findings` answers
 * at most 50 (`FINDINGS_LIST_MAX`), so every open finding fits one answer
 * however many kinds the detectors write.
 */
export const FINDINGS_MAX = 50;
/** Runs itemised in a finding's evidence, largest saving first. */
export const EVIDENCE_RUNS = 10;

/**
 * An RFC 3339 time in microseconds since the epoch. The store prints six
 * fractional digits, and a Date keeps three, so two times in one millisecond
 * compare equal as Dates. Digits past the sixth are dropped. The value stays
 * under 2^53 until the year 2255.
 */
export function microsOf(text: string): number {
  const m = /^(.*?)\.(\d+)(Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (m === null) return Date.parse(text) * 1000;
  const seconds = Date.parse(`${m[1]}${m[3]}`);
  return seconds * 1000 + Number(m[2]!.slice(0, 6).padEnd(6, "0"));
}

/** A call's or frame's time in microseconds, from its store text when known. */
export function timeOf(x: { at: Date; atMicros?: number }): number {
  return x.atMicros ?? x.at.getTime() * 1000;
}

/** One tool call of a wrapped run, as the hook recorded it. */
export interface ToolCallObservation {
  /** The run's public id (`tse_…`). */
  runId: string;
  at: Date;
  /**
   * `at` in microseconds since the epoch, from the store's own text; absent
   * when only a Date is known. A Date drops the store's sub-millisecond
   * digits, so a call and a frame in one millisecond need this to order.
   */
  atMicros?: number;
  seq: number;
  tool: string;
  inputDigest: string;
  /** Empty when the hook recorded no output. */
  outputDigest: string;
  /** Null when the classifier said nothing. */
  isMutating: boolean | null;
  /** The result tokens the span recorded; null when none did. */
  resultTokens: number | null;
  /**
   * The subagent chain the call was recorded on; null when it is on the run's
   * own chain (#4001). `seq` is a position on this chain, so a cited frame
   * names the two together.
   */
  sessionUuid: string | null;
  /**
   * The fields below are optional so a call literal that predates them still
   * types. The findings store sets both on each call it reads.
   */
  /** `ok`, `error`, or `rejected`; null for any other status the hook wrote. */
  status?: "ok" | "error" | "rejected" | null;
  /** The first line of a failed call's error; null when the hook recorded none. */
  errorClass?: string | null;
}

/**
 * One model call of a run, priced once by the rollup's rule (ADR-208). A
 * request finding counts this frame's whole cost.
 */
export interface PricedRequestFrame {
  /**
   * The frame's key within its run: `at` exactly as the store printed it,
   * then `#` and the frame's position among the run's frames at that same
   * instant. A Date would drop the store's sub-millisecond digits.
   */
  key: string;
  at: Date;
  /** `at` in microseconds since the epoch, as on {@link ToolCallObservation}. */
  atMicros?: number;
  /** The frame's priced cost in micros; null when no price covers it. */
  costMicros: bigint | null;
  /** Every token the frame carried, of every class. */
  tokens: number;
  /** Null when no price covers the frame. */
  basis: CostBasis | null;
  /**
   * The chain the frame was recorded on: null on the run's own chain, and a
   * subagent's session uuid otherwise, as on {@link ToolCallObservation}.
   * Absent when the store names no chain.
   */
  sessionUuid?: string | null;
  /**
   * The fields below are optional so a frame literal that predates them
   * still types. The findings store sets every one on each frame it reads.
   */
  /** The model the call ran on, as the frame names it. */
  model?: string;
  /** The provider the frame names; null when it names none. */
  provider?: string | null;
  /** The frame's tokens by class, as the rollup prices them. */
  classTokens?: TokenCounts;
  /**
   * Each class's price entry at the frame's own instant, the one the rollup
   * would resolve for this model and class. Null for a class the book has no
   * entry for. Every class is listed, whether or not the frame carried it.
   */
  classPrices?: FrameClassPrices;
  /**
   * The tokens the call spent on tool definitions, context frames, and
   * steering, as the recorder measured them (#4493). Null when the frame
   * carried none. A ledger frame carries none.
   */
  toolDefinitionTokens?: number | null;
  contextFrameTokens?: number | null;
  steeringTokens?: number | null;
  /** The digest over the ordered parts of the call's system context; null when the frame carried none. */
  systemContextDigest?: string | null;
  /**
   * The parts that digest covers, in request order. The recorder lists them
   * once per digest, so the store takes them from the latest frame of the run
   * at or before this one whose digest matches and whose list is set. Null
   * when no such frame was read.
   */
  systemContextParts?: readonly FrameContextPart[] | null;
}

/** One class's price at a frame's instant, from the price book. */
export interface FrameClassPrice {
  /** The price entry's id. */
  entryId: string;
  /** Micro-units per million tokens, or per request for `server_tool_request`. */
  microsPerMillion: bigint;
  currency: string;
  source: PriceEntry["source"];
}

export type FrameClassPrices = Readonly<
  Record<keyof TokenCounts, FrameClassPrice | null>
>;

/**
 * One part of a call's system context, as ids, digests, and counts (the
 * tacho `systemContextPartSchema`). The text never travels.
 */
export interface FrameContextPart {
  kind: "system" | "tool" | "steering" | "context";
  /** The tool's name, the steering record's id, or the system block's position. */
  name: string;
  /** On a tool part: the MCP server that serves it, or `builtin`. */
  provider?: string;
  digest: string;
  tokens: number;
}

/** A run's first prompt on its own chain, from its first `turn_start` frame with a prompt. */
export interface RunFirstPrompt {
  at: Date;
  /** `at` in microseconds since the epoch, from the store's own text. */
  atMicros: number;
  /** `prompt_digest`. */
  digest: string;
  /** Who sent the prompt (`prompt_source`); null when the recorder set none. */
  source: string | null;
  /** `prompt_origin`; null when the recorder set none. */
  origin: string | null;
  /** The slash command the prompt ran (`command_name`); null for typed text. */
  commandName: string | null;
}

/** One compaction of a run's context, from an `oxagen:compaction` frame. */
export interface RunCompaction {
  at: Date;
  /** `at` in microseconds since the epoch, from the store's own text. */
  atMicros: number;
  seq: number;
  /** Null on the run's own chain, and the subagent's session uuid otherwise. */
  sessionUuid: string | null;
  /** `compact_trigger`, such as `auto` or `manual`; null when the frame set none. */
  trigger: string | null;
  /** The context size before and after, when the frame carried them. */
  tokensBefore: number | null;
  tokensAfter: number | null;
}

/**
 * How many of the window's runs the pass read model-call frames for. A run
 * past the frame read cap is not read, and this counts it, so a detector and
 * a reader can tell a run with no frames from a run whose frames were not
 * read (ADR-210).
 */
export interface FrameCoverage {
  /** The window's runs. */
  runs: number;
  /** The runs whose frames the pass read. */
  read: number;
  /** The runs the cap left unread. */
  capped: number;
  /** The runs with no frame source to read: no session row, or no ledger run row. */
  unmatched: number;
}

/**
 * A setting a finding's fix names, with the value it proposes. A detector
 * sets it through {@link Groups.recommend}, and the evidence stores it, so a
 * reader can show the change without parsing the fix text.
 */
export interface FindingRecommendation {
  /** What to change, such as `cache_ttl`. */
  setting: string;
  /** The proposed value, such as `1h`. */
  value: string | number;
  /** The value in effect across the cited runs, when one holds for all of them. */
  current?: string | number;
}

/**
 * The detectors whose findings add to the unproductive spend headline, in
 * the order they claim a frame (ADR-208, counting rule 1): 1 spin loops,
 * 7 recurring runs, 8 spend with no outcome.
 */
export type CountingDetector = 1 | 7 | 8;

/** One model-call frame a whole-request finding claims (ADR-208). */
export interface FindingClaim {
  detector: CountingDetector;
  /** The run's public id. */
  runId: string;
  frameKey: string;
  frameAt: Date;
  /** The operator whose run it is (`prn_…`); null when the run names none. */
  operatorKey: string | null;
  costMicros: bigint;
}

/** One cited call, by its frame: `sessionUuid` is absent on the run's own chain. */
export interface FindingCitedFrame {
  seq: string;
  sessionUuid?: string;
}

interface FindingRunEvidence {
  runId: string;
  startedAt: string;
  calls: number;
  measuredTokens: number;
  counterfactualTokens: number;
  /** Micro-units as decimal strings. */
  measuredMicros: string;
  counterfactualMicros: string;
}

/** The arithmetic behind a saving, as `cost.findings.cited_frames` stores it. */
export interface FindingEvidence {
  /** The cited items: calls, runs, or model requests, as the kind counts them. */
  calls: number;
  coveredCalls: number;
  measuredTokens: number;
  counterfactualTokens: number;
  measuredMicros: string;
  counterfactualMicros: string;
  /** The operators whose runs are cited (`prn_…`). */
  operatorKeys: string[];
  runs: FindingRunEvidence[];
  /**
   * The cited calls by run public id, for every run the tool-call detectors
   * cited (#4001): seqs ascending, at most `FINDING_FRAMES_PER_RUN`, with
   * `total` counting every cited call. Absent on a finding that cites whole
   * runs, and on a row written before this was stored; a reader then answers
   * `frames: null`.
   */
  frames?: Record<string, { seqs: FindingCitedFrame[]; total: number }>;
  /** The setting the fix proposes; absent on a finding whose fix names none. */
  recommendation?: FindingRecommendation;
}

export interface FindingDraft {
  kind: FindingKind;
  level: FindingLevel;
  subject: string;
  fingerprint: string;
  windowStart: Date;
  windowEnd: Date;
  savingMicros: bigint;
  currency: string;
  basis: CostBasis;
  confidence: FindingConfidence;
  why: string;
  fix: string;
  citedRuns: string[];
  evidence: FindingEvidence;
  /** The frames a whole-request finding claims; absent on every other finding. */
  claims?: FindingClaim[];
  /** The setting the fix proposes, as the evidence stores it; absent when the fix names none. */
  recommendation?: FindingRecommendation;
}

/**
 * What the detectors read. The fields past `decidedSince` are optional so a
 * detector test can build only what it reads. The findings store sets every
 * one of them ({@link DetectReads}), and a detector treats an absent map as
 * not read, never as empty.
 */
export interface DetectInput {
  window: { start: Date; end: Date };
  /** Where the tool-call read begins; later than `window.start` when the read was capped. */
  toolWindowStart: Date;
  runs: readonly RunTotalsRecord[];
  toolCalls: readonly ToolCallObservation[];
  /** Per fingerprint, the latest time a person applied or dismissed it; only runs that started later count. */
  decidedSince: ReadonlyMap<string, Date>;
  /**
   * The priced model-call frames of the runs the store read them for, by run
   * public id, in time order. A run absent here has its request findings
   * cited but not covered.
   */
  frames?: ReadonlyMap<string, readonly PricedRequestFrame[]>;
  /** The window's operator prompts, for detector 6; absent when the store read none. */
  prompts?: PromptRead;
  /**
   * Each wrapped run's first prompt on its own chain, by run public id. A run
   * absent here recorded no prompt in the window. A ledger run is never here.
   */
  firstPrompts?: ReadonlyMap<string, RunFirstPrompt>;
  /**
   * Whether each wrapped run changed a file, by run public id: true when a
   * session of the run wrote, edited, or deleted a file, or saw one added,
   * modified, deleted, or renamed, or when a file's digest before and after
   * differ. False for a run whose sessions recorded no such change. A ledger
   * run is never here.
   */
  fileChanges?: ReadonlyMap<string, boolean>;
  /**
   * When each wrapped run's files changed on disk, from its
   * `oxagen:file_changed` frames on every chain: microseconds since the
   * epoch, ascending, by run public id. A run with no change is absent. The
   * read covers `from` to the window's end, and `from` is later than the
   * window's start when the read hit its cap, so a detector does not read a
   * stretch the read missed as one with no change.
   */
  fileChangeTimes?: {
    from: Date;
    byRun: ReadonlyMap<string, readonly number[]>;
  };
  /**
   * Each wrapped run's compactions in time order, by run public id, on every
   * chain of the run. A run with none is absent. A ledger run is never here.
   */
  compactions?: ReadonlyMap<string, readonly RunCompaction[]>;
  /**
   * Each run's rows of `cost.run_pr_outcomes`, by run public id. A run with
   * no row is absent.
   */
  outcomes?: ReadonlyMap<string, readonly OutcomeRow[]>;
  /** How many of the window's runs had their model-call frames read. */
  frameCoverage?: FrameCoverage;
}

/** The input the findings store builds: every read is set. */
export type DetectReads = DetectInput &
  Required<
    Pick<
      DetectInput,
      | "frames"
      | "firstPrompts"
      | "fileChanges"
      | "compactions"
      | "outcomes"
      | "frameCoverage"
    >
  >;

export function findingFingerprint(
  kind: FindingKind,
  level: FindingLevel,
  subject: string,
): string {
  return `${kind}|${level}|${subject}`;
}

/** A finding's grouping key. */
export interface FindingKey {
  kind: FindingKind;
  level: FindingLevel;
  subject: string;
}

/** A call's frame: its position on the chain it was recorded on. */
export interface CallFrame {
  seq: number;
  /** Null on the run's own chain. */
  sessionUuid: string | null;
}

interface RunAcc {
  run: RunTotalsRecord;
  calls: number;
  /**
   * The cited items in this run the counterfactual priced. The measured and
   * counterfactual sums below count only these, so prose that splits the
   * sums reads the runs where this is above 0.
   */
  covered: number;
  measuredTokens: number;
  counterfactualTokens: number;
  measuredMicros: bigint;
  counterfactualMicros: bigint;
  /** The frames of the calls cited in this run; empty for a finding that cites whole runs. */
  frames: CallFrame[];
}

export interface Group {
  kind: FindingKind;
  level: FindingLevel;
  subject: string;
  windowStart: Date;
  calls: number;
  covered: number;
  basis: CostBasis | null;
  runs: Map<string, RunAcc>;
  /** Whether the finding pins the calls it cites; false for a finding over whole runs. */
  citesCalls: boolean;
  claims: FindingClaim[];
  /** The setting the finding's fix proposes; see {@link Groups.recommend}. */
  recommendation?: FindingRecommendation;
  /**
   * Every frame an item of this group claimed, priced or not. `claims` holds
   * only the priced ones. The pass frees these frames when the group is not
   * written, so a later counting detector can claim them (#4607).
   */
  claimedFrames?: { runId: string; frameKey: string }[];
}

/** An item's measured and counterfactual sides; null micros when the counterfactual does not cover it. */
export interface Measure {
  measuredTokens: number;
  counterfactualTokens: number;
  micros: { measured: bigint; counterfactual: bigint } | null;
  /** The basis of the measured side; the run's own basis when absent. */
  basis?: CostBasis | null;
}

/** The frame a whole-request item claims when the counterfactual covers it. */
export interface ClaimOf {
  detector: CountingDetector;
  frame: PricedRequestFrame;
}

export class Groups {
  private readonly groups = new Map<string, Group>();

  constructor(private readonly decidedSince: ReadonlyMap<string, Date>) {}

  /** Whether a run may be cited under a key. */
  admits(key: FindingKey, run: RunTotalsRecord): boolean {
    const since = this.decidedSince.get(
      findingFingerprint(key.kind, key.level, key.subject),
    );
    return since === undefined || run.startedAt.getTime() > since.getTime();
  }

  add(
    key: FindingKey,
    windowStart: Date,
    run: RunTotalsRecord,
    measure: Measure,
    /** The cited calls' frames; null when the finding cites the run as a whole. */
    frames: readonly CallFrame[] | null,
    claim: ClaimOf | null = null,
  ): void {
    const fingerprint = findingFingerprint(key.kind, key.level, key.subject);
    let group = this.groups.get(fingerprint);
    if (!group) {
      // A decided fingerprint cites only runs that started after the
      // decision, so its window starts there.
      const since = this.decidedSince.get(fingerprint);
      group = {
        ...key,
        windowStart:
          since !== undefined && since.getTime() > windowStart.getTime()
            ? since
            : windowStart,
        calls: 0,
        covered: 0,
        basis: null,
        runs: new Map(),
        citesCalls: frames !== null,
        claims: [],
      };
      this.groups.set(fingerprint, group);
    }
    let acc = group.runs.get(run.runId);
    if (!acc) {
      acc = {
        run,
        calls: 0,
        covered: 0,
        measuredTokens: 0,
        counterfactualTokens: 0,
        measuredMicros: 0n,
        counterfactualMicros: 0n,
        frames: [],
      };
      group.runs.set(run.runId, acc);
    }
    group.calls += 1;
    acc.calls += 1;
    if (claim !== null) {
      group.claimedFrames ??= [];
      group.claimedFrames.push({ runId: run.runId, frameKey: claim.frame.key });
    }
    // Every cited call is pinned, covered or not: the Run page draws the
    // call the finding names, whatever the counterfactual could price.
    if (frames !== null) acc.frames.push(...frames);
    const basis = measure.basis === undefined ? run.costBasis : measure.basis;
    if (measure.micros === null || basis === null) return;
    group.covered += 1;
    acc.covered += 1;
    group.basis = foldBasis(group.basis, basis);
    acc.measuredTokens += measure.measuredTokens;
    acc.counterfactualTokens += measure.counterfactualTokens;
    acc.measuredMicros += measure.micros.measured;
    acc.counterfactualMicros += measure.micros.counterfactual;
    if (claim !== null && claim.frame.costMicros !== null)
      group.claims.push({
        detector: claim.detector,
        runId: run.runId,
        frameKey: claim.frame.key,
        frameAt: claim.frame.at,
        operatorKey: run.operatorKey,
        costMicros: claim.frame.costMicros,
      });
  }

  /**
   * Set the setting a finding's fix proposes. The group must exist, so a
   * detector calls this after its first `add` under the key. Returns false
   * when no run was added under the key yet.
   */
  recommend(key: FindingKey, recommendation: FindingRecommendation): boolean {
    const group = this.groups.get(
      findingFingerprint(key.kind, key.level, key.subject),
    );
    if (group === undefined) return false;
    group.recommendation = recommendation;
    return true;
  }

  values(): IterableIterator<Group> {
    return this.groups.values();
  }
}

/** A result's tokens at the run's input price, against a counterfactual number of tokens. */
export function resultMeasure(
  run: RunTotalsRecord,
  resultTokens: number | null,
  counterfactualTokens: (measured: number) => number,
): Measure {
  const price = runInputPrice(run);
  if (resultTokens === null)
    return { measuredTokens: 0, counterfactualTokens: 0, micros: null };
  const counterfactual = counterfactualTokens(resultTokens);
  return {
    measuredTokens: resultTokens,
    counterfactualTokens: counterfactual,
    micros:
      price === null
        ? null
        : {
            measured: priceInputTokens(price, resultTokens),
            counterfactual: priceInputTokens(price, counterfactual),
          },
  };
}

/**
 * A whole request at its own priced cost, against nothing: the request did
 * no work the run needed.
 */
export function requestMeasure(frame: PricedRequestFrame | null): Measure {
  if (frame === null || frame.costMicros === null)
    return { measuredTokens: 0, counterfactualTokens: 0, micros: null };
  return {
    measuredTokens: frame.tokens,
    counterfactualTokens: 0,
    micros: { measured: frame.costMicros, counterfactual: 0n },
    basis: frame.basis,
  };
}

/** The agent a run names, or its operator when it names no agent; null when it names neither. */
export function agentOrOperator(
  kind: FindingKind,
  run: RunTotalsRecord,
): FindingKey | null {
  if (run.agentKey !== null)
    return { kind, level: "agent", subject: run.agentKey };
  if (run.operatorKey !== null)
    return { kind, level: "operator", subject: run.operatorKey };
  return null;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * One run's cited frames as stored: seqs ascending (a subagent chain's after
 * the run's own at the same seq), at most FINDING_FRAMES_PER_RUN, with the
 * total counting every cited call.
 */
function citedFrames(frames: readonly CallFrame[]): {
  seqs: FindingCitedFrame[];
  total: number;
} {
  const ordered = [...frames].sort((a, b) =>
    a.seq !== b.seq
      ? a.seq - b.seq
      : (a.sessionUuid ?? "") < (b.sessionUuid ?? "")
        ? -1
        : (a.sessionUuid ?? "") > (b.sessionUuid ?? "")
          ? 1
          : 0,
  );
  return {
    seqs: ordered
      .slice(0, FINDING_FRAMES_PER_RUN)
      .map((f) =>
        f.sessionUuid === null
          ? { seq: String(f.seq) }
          : { seq: String(f.seq), sessionUuid: f.sessionUuid },
      ),
    total: frames.length,
  };
}

export type Prose = (
  group: Group,
  evidence: FindingEvidence,
) => { why: string; fix: string };

/** What one pass shares between its detectors. */
export interface DetectContext {
  groups: Groups;
  runs: ReadonlyMap<string, RunTotalsRecord>;
  /** Each run's calls and requests; see ./requests.ts. */
  views: readonly RunView[];
  /**
   * The frames a counting detector already claimed this pass, by
   * `claimKey(runId, frameKey)`. A later detector skips them, so a frame
   * counts under the first detector in counting order (ADR-208).
   */
  claimed: Set<string>;
  /** The tool calls a finding already cites, which a later detector skips. */
  taken: Set<ToolCallObservation>;
}

/**
 * One detector as `detectFindings` runs it. `counting` names the headline
 * detector a whole-request finding claims frames as (ADR-208); null for a
 * detector that prices a part of a request and claims none.
 */
export interface Detector {
  kinds: readonly FindingKind[];
  counting: CountingDetector | null;
  detect(input: DetectInput, ctx: DetectContext): void;
  prose: Prose;
}

export function toDraft(
  group: Group,
  windowEnd: Date,
  prose: Prose,
): FindingDraft | null {
  if (group.calls === 0 || group.basis === null) return null;
  const coverage = group.covered / group.calls;
  if (coverage < MIN_COVERAGE) return null;
  const accs = [...group.runs.values()];
  let measuredMicros = 0n;
  let counterfactualMicros = 0n;
  let measuredTokens = 0;
  let counterfactualTokens = 0;
  for (const a of accs) {
    measuredMicros += a.measuredMicros;
    counterfactualMicros += a.counterfactualMicros;
    measuredTokens += a.measuredTokens;
    counterfactualTokens += a.counterfactualTokens;
  }
  const savingMicros = measuredMicros - counterfactualMicros;
  if (savingMicros < MIN_SAVING_MICROS) return null;

  const saving = (a: RunAcc) => a.measuredMicros - a.counterfactualMicros;
  const ranked = accs.sort((a, b) => {
    const d = saving(b) - saving(a);
    return d > 0n ? 1 : d < 0n ? -1 : a.run.runId < b.run.runId ? -1 : 1;
  });
  const evidence: FindingEvidence = {
    calls: group.calls,
    coveredCalls: group.covered,
    measuredTokens,
    counterfactualTokens,
    measuredMicros: measuredMicros.toString(),
    counterfactualMicros: counterfactualMicros.toString(),
    operatorKeys: [
      ...new Set(
        accs
          .map((a) => a.run.operatorKey)
          .filter((k): k is string => k !== null),
      ),
    ].sort(),
    runs: ranked.slice(0, EVIDENCE_RUNS).map((a) => ({
      runId: a.run.runId,
      startedAt: a.run.startedAt.toISOString(),
      calls: a.calls,
      measuredTokens: a.measuredTokens,
      counterfactualTokens: a.counterfactualTokens,
      measuredMicros: a.measuredMicros.toString(),
      counterfactualMicros: a.counterfactualMicros.toString(),
    })),
  };
  // A finding over whole runs pins no frame; the tool-call detectors cite one
  // per call, in every run they cite, not only the ten itemised above.
  if (group.citesCalls)
    evidence.frames = Object.fromEntries(
      accs.map((a) => [a.run.runId, citedFrames(a.frames)]),
    );
  if (group.recommendation !== undefined)
    evidence.recommendation = { ...group.recommendation };
  const draft: FindingDraft = {
    kind: group.kind,
    level: group.level,
    subject: group.subject,
    fingerprint: findingFingerprint(group.kind, group.level, group.subject),
    windowStart: group.windowStart,
    windowEnd,
    savingMicros,
    currency: ranked[0]!.run.currency,
    basis: group.basis,
    confidence: coverage >= HIGH_CONFIDENCE_COVERAGE ? "high" : "medium",
    ...prose(group, evidence),
    citedRuns: ranked.map((a) => a.run.runId),
    evidence,
  };
  if (group.claims.length > 0) draft.claims = group.claims;
  if (group.recommendation !== undefined)
    draft.recommendation = { ...group.recommendation };
  return draft;
}
