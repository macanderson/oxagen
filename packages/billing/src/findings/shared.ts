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
}

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
}

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
    // Every cited call is pinned, covered or not: the Run page draws the
    // call the finding names, whatever the counterfactual could price.
    if (frames !== null) acc.frames.push(...frames);
    const basis = measure.basis === undefined ? run.costBasis : measure.basis;
    if (measure.micros === null || basis === null) return;
    group.covered += 1;
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
  return draft;
}
