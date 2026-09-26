/**
 * findings.ts — the PURE findings detectors (Mission Control spec §12.8;
 * ADR-062). No I/O: ./findings-store.ts reads the run rows and the tool-call
 * frames and writes `cost.findings`, and this module is what the tests
 * exercise.
 *
 * A finding is a specific, costed problem over the runs it cites. Its saving
 * is measured minus counterfactual over those runs, at the price each run
 * paid: the measured side is what the frames cost, the counterfactual side is
 * the same work re-priced at the alternative the finding names (a result the
 * run already held, a paged result, a prefix that was never cached). The
 * price of an input token is the run's own: the input the rollup priced for
 * it, divided by the input tokens it carried. A call whose run has no such
 * price, or whose result tokens were not recorded, is cited but not covered;
 * confidence is the share of cited calls the counterfactual covers, and a
 * group whose coverage is under half is not written.
 *
 * Every call contributes to at most one finding. A repeat inside a run is a
 * repeated shell command (Bash) or a duplicate tool call (a read-only tool);
 * any other call whose result is above the unpaged threshold is an unpaged
 * result.
 */
import type {
  CostBasis,
  FindingConfidence,
  FindingKind,
  FindingLevel,
} from "@oxagen/database/schema";
import { divideHalfEven, foldBasis, type RunTotalsRecord } from "./cost-rollup";

/** The most cited frames a finding stores per run; the contract's own cap (#4001). */
export { FINDING_FRAMES_PER_RUN } from "@oxagen/oxagen/contracts/finding.shared";

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
/** Runs itemised in a finding's evidence, largest saving first. */
export const EVIDENCE_RUNS = 10;

const SHELL_TOOL = "Bash";

/** One tool call of a wrapped run, as the hook recorded it. */
export interface ToolCallObservation {
  /** The run's public id (`tse_…`). */
  runId: string;
  at: Date;
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
   * own chain (#4001). Optional until the Context and cost lane's reader
   * fills it; absent reads as null.
   */
  sessionUuid?: string | null;
}

/** One cited call, by its frame: `sessionUuid` is absent on the run's own chain. */
interface FindingCitedFrame {
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
   * `total` counting every cited call. Absent on `cache_writes_never_read`,
   * which cites whole runs, and on a row written before this was stored; a
   * reader then answers `frames: null`.
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
}

export interface DetectInput {
  window: { start: Date; end: Date };
  /** Where the tool-call read begins; later than `window.start` when the read was capped. */
  toolWindowStart: Date;
  runs: readonly RunTotalsRecord[];
  toolCalls: readonly ToolCallObservation[];
  /** Per fingerprint, the latest time a person applied or dismissed it; only runs that started later count. */
  decidedSince: ReadonlyMap<string, Date>;
}

export function findingFingerprint(
  kind: FindingKind,
  level: FindingLevel,
  subject: string,
): string {
  return `${kind}|${level}|${subject}`;
}

/** What a run paid for one input token, as a ratio; null when nothing priced its input. */
export function runInputPrice(
  run: RunTotalsRecord,
): { micros: bigint; tokens: bigint } | null {
  if (run.costBasis === null || run.costBasis === "estimated") return null;
  let micros = 0n;
  let tokens = 0n;
  for (const m of run.breakdown.models) {
    micros += m.costByClass.input_uncached;
    tokens += BigInt(m.tokens.input_uncached);
  }
  if (tokens === 0n || micros === 0n) return null;
  return { micros, tokens };
}

function priceTokens(
  price: { micros: bigint; tokens: bigint },
  tokens: number,
): bigint {
  return divideHalfEven(BigInt(tokens) * price.micros, price.tokens);
}

interface RunAcc {
  run: RunTotalsRecord;
  calls: number;
  measuredTokens: number;
  counterfactualTokens: number;
  measuredMicros: bigint;
  counterfactualMicros: bigint;
}

interface Group {
  kind: FindingKind;
  level: FindingLevel;
  subject: string;
  windowStart: Date;
  calls: number;
  covered: number;
  basis: CostBasis | null;
  runs: Map<string, RunAcc>;
}

/** A call's measured and counterfactual sides; null micros when the counterfactual does not cover it. */
interface Measure {
  measuredTokens: number;
  counterfactualTokens: number;
  micros: { measured: bigint; counterfactual: bigint } | null;
}

class Groups {
  private readonly groups = new Map<string, Group>();

  constructor(private readonly decidedSince: ReadonlyMap<string, Date>) {}

  /** Whether a run may be cited under a fingerprint. */
  admits(fingerprint: string, run: RunTotalsRecord): boolean {
    const since = this.decidedSince.get(fingerprint);
    return since === undefined || run.startedAt.getTime() > since.getTime();
  }

  add(
    key: { kind: FindingKind; level: FindingLevel; subject: string },
    windowStart: Date,
    run: RunTotalsRecord,
    measure: Measure,
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
      };
      group.runs.set(run.runId, acc);
    }
    group.calls += 1;
    acc.calls += 1;
    if (measure.micros === null || run.costBasis === null) return;
    group.covered += 1;
    group.basis = foldBasis(group.basis, run.costBasis);
    acc.measuredTokens += measure.measuredTokens;
    acc.counterfactualTokens += measure.counterfactualTokens;
    acc.measuredMicros += measure.micros.measured;
    acc.counterfactualMicros += measure.micros.counterfactual;
  }

  values(): IterableIterator<Group> {
    return this.groups.values();
  }
}

// ── Detectors ─────────────────────────────────────────────────────────────────

/**
 * Cache writes never read (spec §12.8): a run that wrote prompt-cache tokens
 * and read none back. The counterfactual is the same prefix sent uncached, so
 * the saving is the write premium: the write cost minus the written tokens at
 * the run's input price. Cited at the run's operator, or at its agent when it
 * names no operator.
 */
function detectCacheWritesNeverRead(input: DetectInput, groups: Groups): void {
  for (const run of input.runs) {
    const wrote = run.tokens.cache_write_5m + run.tokens.cache_write_1h;
    if (wrote === 0 || run.tokens.cache_read > 0) continue;
    const key =
      run.operatorKey !== null
        ? {
            kind: "cache_writes_never_read" as const,
            level: "operator" as const,
            subject: run.operatorKey,
          }
        : run.agentKey !== null
          ? {
              kind: "cache_writes_never_read" as const,
              level: "agent" as const,
              subject: run.agentKey,
            }
          : null;
    if (key === null) continue;
    if (
      !groups.admits(findingFingerprint(key.kind, key.level, key.subject), run)
    )
      continue;
    let measured = 0n;
    for (const m of run.breakdown.models)
      measured += m.costByClass.cache_write_5m + m.costByClass.cache_write_1h;
    const price = runInputPrice(run);
    groups.add(key, input.window.start, run, {
      measuredTokens: wrote,
      counterfactualTokens: wrote,
      micros:
        price === null || measured === 0n
          ? null
          : { measured, counterfactual: priceTokens(price, wrote) },
    });
  }
}

function resultMeasure(
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
            measured: priceTokens(price, resultTokens),
            counterfactual: priceTokens(price, counterfactual),
          },
  };
}

/**
 * The tool-call detectors, over every call in time order. A call is claimed
 * by the first of: a repeat inside its run (same tool, input digest and
 * output digest as an earlier call of the run) or an unpaged result.
 */
function detectToolCalls(
  input: DetectInput,
  runs: ReadonlyMap<string, RunTotalsRecord>,
  groups: Groups,
): void {
  const calls = input.toolCalls
    .filter((c) => runs.has(c.runId))
    .slice()
    .sort((a, b) =>
      a.at.getTime() !== b.at.getTime()
        ? a.at.getTime() - b.at.getTime()
        : a.runId !== b.runId
          ? a.runId < b.runId
            ? -1
            : 1
          : a.seq - b.seq,
    );
  const seenInRun = new Map<string, Set<string>>();
  const windowStart = input.toolWindowStart;

  for (const call of calls) {
    const run = runs.get(call.runId)!;
    const runKey = `${call.runId}\u0000${call.tool}\u0000${call.inputDigest}`;
    const seen = seenInRun.get(runKey);
    const hasOutput = call.outputDigest !== "";

    let claimed = false;
    if (hasOutput && seen?.has(call.outputDigest)) {
      const key =
        call.tool === SHELL_TOOL
          ? {
              kind: "repeated_shell_commands" as const,
              level: "tool" as const,
              subject: SHELL_TOOL,
            }
          : call.isMutating === false && run.agentKey !== null
            ? {
                kind: "duplicate_tool_calls" as const,
                level: "agent" as const,
                subject: run.agentKey,
              }
            : null;
      if (key !== null) {
        claimed = true;
        if (
          groups.admits(
            findingFingerprint(key.kind, key.level, key.subject),
            run,
          )
        )
          groups.add(
            key,
            windowStart,
            run,
            resultMeasure(run, call.resultTokens, () => 0),
          );
      }
    }

    if (
      !claimed &&
      call.resultTokens !== null &&
      call.resultTokens > UNPAGED_RESULT_TOKENS
    ) {
      const key = {
        kind: "unpaged_results" as const,
        level: "tool" as const,
        subject: call.tool,
      };
      if (
        groups.admits(findingFingerprint(key.kind, key.level, key.subject), run)
      )
        groups.add(
          key,
          windowStart,
          run,
          resultMeasure(run, call.resultTokens, () => PAGE_TOKENS),
        );
    }

    if (hasOutput) {
      if (seen) seen.add(call.outputDigest);
      else seenInRun.set(runKey, new Set([call.outputDigest]));
    }
  }
}

// ── Prose ─────────────────────────────────────────────────────────────────────

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function prose(
  group: Group,
  evidence: FindingEvidence,
): { why: string; fix: string } {
  const runs = plural(group.runs.size, "run", "runs");
  const calls = plural(evidence.calls, "call", "calls");
  switch (group.kind) {
    case "cache_writes_never_read":
      return {
        why: `${runs} wrote ${plural(evidence.measuredTokens, "prompt-cache token", "prompt-cache tokens")} and read none of them back.`,
        fix: "Stop marking the prefix cacheable on runs that end before a second call reads it.",
      };
    case "repeated_shell_commands":
      return {
        why: `${calls} on ${runs} re-ran a shell command whose identical input had already returned the identical output earlier in the run.`,
        fix: "Serve an identical command from the run's earlier result until a write changes what it reads.",
      };
    case "duplicate_tool_calls":
      return {
        why: `${calls} on ${runs} repeated a read-only tool call with an identical input and output digest earlier in the same run.`,
        fix: "Tell the agent not to re-read a result it already holds in the run.",
      };
    case "unpaged_results":
      return {
        why: `${calls} to ${group.subject} on ${runs} returned more than ${UNPAGED_RESULT_TOKENS.toLocaleString("en-US")} result tokens into the context.`,
        fix: `Page ${group.subject}'s results at ${PAGE_TOKENS.toLocaleString("en-US")} tokens and fetch the rest on demand.`,
      };
  }
}

// ── Assembly ──────────────────────────────────────────────────────────────────

function toDraft(group: Group, windowEnd: Date): FindingDraft | null {
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
  return {
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
}

/** Every finding the window's runs and tool calls prove, largest saving first, at most ten per kind. */
export function detectFindings(input: DetectInput): FindingDraft[] {
  const runs = new Map(input.runs.map((r) => [r.runId, r]));
  const groups = new Groups(input.decidedSince);
  detectCacheWritesNeverRead(input, groups);
  detectToolCalls(input, runs, groups);

  const byKind = new Map<FindingKind, FindingDraft[]>();
  for (const group of groups.values()) {
    const draft = toDraft(group, input.window.end);
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
    .sort(bySaving);
}
