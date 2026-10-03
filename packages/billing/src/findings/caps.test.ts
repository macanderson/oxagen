/**
 * The findings caps and the unproductive spend headline (#5050, #5262). The
 * caps never cut a finding that counts toward the headline, so every frame a
 * counting detector claims belongs to a stored finding, and the headline
 * equals the sum of the findings behind it. The caps still bound the
 * advisory findings, which count toward nothing. These tests check both, and
 * that a replay keeps the claims of every counting group a pass keeps.
 */
import type { FindingKind } from "@oxagen/database/schema";
import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import { blankOutcome, type OutcomeRow } from "../run-pr-outcomes";
import {
  detectInputFixture,
  FIXTURE_WINDOW_END,
  FIXTURE_WINDOW_START,
} from "./detect-input-fixture";
import {
  countClaims,
  detectFindings,
  FINDINGS_MAX,
  FINDINGS_PER_KIND,
  replayClaims,
  requestMeasure,
  type Detector,
  type DetectReads,
  type FindingDraft,
  type PricedRequestFrame,
  type RunFirstPrompt,
} from "./index";
import { RECURRING_RUNS_MIN, recurringRuns } from "./recurring-runs";
import { claimKey } from "./requests";
import { spendWithNoOutcome } from "./spend-with-no-outcome";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const OPERATOR = "prn_0123456789abcdefghjkmn";
const TURN_MICROS = 12_000n;
const TURN_TOKENS = 4_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Every run starts after this, two days into the window. */
const RUNS_FROM = new Date(FIXTURE_WINDOW_START.getTime() + 2 * DAY_MS);
/** Each run starts this long after the one before. */
const RUN_SPACING_MS = 10 * 60_000;

/** The kinds detector 1 writes. */
const DETECTOR_1_KINDS: readonly FindingKind[] = [
  "spin_loops",
  "retry_loops",
  "duplicate_tool_calls",
  "repeated_shell_commands",
];
/** Six kinds no counting detector writes: the advisory kinds. */
const OTHER_KINDS: readonly FindingKind[] = [
  "cache_busts",
  "unpaged_results",
  "standing_context",
  "cache_writes_never_read",
  "idle_cache_rewrites",
  "model_class_fit",
];
/** Past both caps: two more than `FINDINGS_PER_KIND` of every counting kind. */
const PAST_THE_CAP = FINDINGS_PER_KIND + 2;

let seq = 0;

/** A sealed run, five minutes long, with three model calls and no tool call. */
function run(agentKey: string): RunTotalsRecord {
  seq += 1;
  const startedAt = new Date(RUNS_FROM.getTime() + seq * RUN_SPACING_MS);
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    runSource: "tacho",
    orgId: ORG,
    workspaceId: WS,
    operatorPrincipalId: null,
    operatorKey: OPERATOR,
    agentPrincipalId: null,
    agentKey,
    taskRef: null,
    costCenter: null,
    startedAt,
    sealedAt: new Date(startedAt.getTime() + 5 * 60_000),
    turns: 3,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 3,
    modelCalls: 3,
    toolCalls: 0,
    tokens: { ...ZERO_TOKENS, input_uncached: 12_000 },
    costMicros: 3n * TURN_MICROS,
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: { models: [], tools: [], steps: null },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
  };
}

/** Three model requests, one a second from the run's start. */
function framesOf(r: RunTotalsRecord): PricedRequestFrame[] {
  return [1, 2, 3].map((i) => {
    const at = new Date(r.startedAt.getTime() + i * 1_000);
    return {
      key: `${at.toISOString()}#0`,
      at,
      costMicros: TURN_MICROS,
      tokens: TURN_TOKENS,
      basis: "gateway_observed",
    };
  });
}

function firstPrompt(r: RunTotalsRecord, digest: string): RunFirstPrompt {
  return {
    at: r.startedAt,
    atMicros: r.startedAt.getTime() * 1000,
    digest,
    source: null,
    origin: null,
    commandName: null,
  };
}

/** A pull request the run opened that closed unmerged a day after it started. */
function closedUnmerged(r: RunTotalsRecord): OutcomeRow {
  return {
    ...blankOutcome(r.runId, "tacho", {
      provider: "github",
      repository: "acme/core",
      number: 1,
      url: null,
    }),
    prState: "closed",
    closedAt: new Date(r.startedAt.getTime() + DAY_MS),
    prStateReadAt: FIXTURE_WINDOW_END,
  };
}

/** The runs a test's pass reads. */
interface PassRuns {
  /** Runs of a recurring job, by first prompt digest. */
  jobs?: Record<string, RunTotalsRecord[]>;
  /** Runs whose pull request closed unmerged. */
  closed?: RunTotalsRecord[];
  /** Other runs, read with their frames and nothing else. */
  others?: RunTotalsRecord[];
}

/** The reads: every run's three frames, and each job run's first prompt. */
function reads({ jobs = {}, closed = [], others = [] }: PassRuns): DetectReads {
  const fromJobs = Object.values(jobs).flat();
  const runs = [...fromJobs, ...closed, ...others];
  const firstPrompts = new Map<string, RunFirstPrompt>();
  for (const [digest, list] of Object.entries(jobs))
    for (const r of list) firstPrompts.set(r.runId, firstPrompt(r, digest));
  return detectInputFixture({
    runs,
    firstPrompts,
    fileChanges: new Map(runs.map((r) => [r.runId, false])),
    frames: new Map(runs.map((r) => [r.runId, framesOf(r)])),
    outcomes: new Map(closed.map((r) => [r.runId, [closedUnmerged(r)]])),
  });
}

/** `n` recurring jobs, one agent each. */
function recurringJobs(n: number): Record<string, RunTotalsRecord[]> {
  const jobs: Record<string, RunTotalsRecord[]> = {};
  for (let i = 0; i < n; i += 1)
    jobs[`sha256:job-${i}`] = Array.from({ length: RECURRING_RUNS_MIN }, () =>
      run(`acme.job.${i}`),
    );
  return jobs;
}

/**
 * A detector that claims as detector 1, as spin loops do: one finding per
 * run in `runs`, under the run's agent, of the kind the run is listed under.
 * Each finding claims its run's frames that no earlier detector claimed.
 */
function detector1(
  runs: ReadonlyMap<FindingKind, RunTotalsRecord[]>,
): Detector {
  return {
    kinds: [...runs.keys()],
    counting: 1,
    detect(input, ctx) {
      for (const [kind, list] of runs)
        for (const r of list) {
          const key = { kind, level: "agent" as const, subject: r.agentKey! };
          for (const frame of input.frames?.get(r.runId) ?? []) {
            const claim = claimKey(r.runId, frame.key);
            if (ctx.claimed.has(claim)) continue;
            ctx.claimed.add(claim);
            ctx.groups.add(
              key,
              input.window.start,
              r,
              requestMeasure(frame),
              null,
              { detector: 1, frame },
            );
          }
        }
    },
    prose: () => ({ why: "Detector 1.", fix: "Stop the loop." }),
  };
}

/**
 * A detector that claims no frame: `perKind` findings of each kind it names.
 * The finding at index i of the kind at index k saves `saving + 1000k + i`
 * micros, so a later kind's findings all rank above an earlier kind's, and
 * within a kind index 0 is the smallest.
 */
function nonCounting(
  kinds: readonly FindingKind[],
  saving: bigint,
  perKind: number = FINDINGS_PER_KIND,
): Detector {
  const r = run("acme.other");
  return {
    kinds,
    counting: null,
    detect(input, ctx) {
      kinds.forEach((kind, k) => {
        for (let i = 0; i < perKind; i += 1)
          ctx.groups.add(
            { kind, level: "agent", subject: `acme.${kind}.${i}` },
            input.window.start,
            r,
            {
              measuredTokens: 1,
              counterfactualTokens: 0,
              micros: {
                measured: saving + BigInt(k) * 1_000n + BigInt(i),
                counterfactual: 0n,
              },
            },
            null,
          );
      });
    },
    prose: () => ({ why: "Other.", fix: "Change the setting." }),
  };
}

/** Each written finding's claims, by fingerprint. */
function claimsOf(findings: readonly FindingDraft[]) {
  return new Map(
    findings.filter((f) => f.claims).map((f) => [f.fingerprint, f.claims!]),
  );
}

/** Every claim of every written finding, as the store writes them. */
function stored(findings: readonly FindingDraft[]) {
  return findings.flatMap((f) => f.claims ?? []);
}

/** Each run's frames, as `claimKey` names them. */
function frameKeys(runs: readonly RunTotalsRecord[]): string[] {
  return runs.flatMap((r) => framesOf(r).map((f) => claimKey(r.runId, f.key)));
}

/** `n` runs whose pull request closed unmerged, one agent each. */
function noOutcomeRuns(n: number): RunTotalsRecord[] {
  return Array.from({ length: n }, (_, i) => run(`acme.closed.${i}`));
}

/** How many findings of each kind. */
function kindCounts(findings: readonly FindingDraft[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of findings) out.set(f.kind, (out.get(f.kind) ?? 0) + 1);
  return out;
}

/**
 * Every counting kind past both caps: `PAST_THE_CAP` runs of each detector 1
 * kind, `PAST_THE_CAP` recurring jobs, and `PAST_THE_CAP` runs with no
 * outcome, each under its own agent. That is 72 counting findings, more than
 * `FINDINGS_MAX`.
 */
function pastBothCaps(advisory: Detector[] = []) {
  const byKind = new Map(
    DETECTOR_1_KINDS.map((kind) => [
      kind,
      Array.from({ length: PAST_THE_CAP }, (_, i) => run(`acme.${kind}.${i}`)),
    ]),
  );
  const looped = [...byKind.values()].flat();
  const jobs = recurringJobs(PAST_THE_CAP);
  const closed = noOutcomeRuns(PAST_THE_CAP);
  const input = reads({ jobs, closed, others: looped });
  const detectors = [
    detector1(byKind),
    recurringRuns,
    spendWithNoOutcome,
    ...advisory,
  ];
  const runs = [...looped, ...Object.values(jobs).flat(), ...closed];
  return { input, detectors, runs };
}

/** The counting findings: those of detectors 1, 7, and 8. */
function counting(findings: readonly FindingDraft[]): FindingDraft[] {
  return findings.filter((f) => f.claims !== undefined);
}

describe("the findings caps and the headline (#5050, #5262)", () => {
  it("stores a finding for each of 12 agents' spend with no outcome, and the headline counts each claimed frame once", () => {
    const agents = noOutcomeRuns(12);
    expect(agents.length).toBeGreaterThan(FINDINGS_PER_KIND);
    const input = reads({ closed: agents });
    // The pass as it runs: every registered detector, in counting order.
    const findings = detectFindings(input);

    const noOutcome = findings.filter(
      (f) => f.kind === "spend_with_no_outcome",
    );
    expect(noOutcome).toHaveLength(12);
    expect(new Set(noOutcome.map((f) => f.subject))).toEqual(
      new Set(agents.map((r) => r.agentKey)),
    );
    // Every frame of the 12 runs is claimed once, under detector 8, and the
    // headline adds each one once.
    const claims = stored(findings);
    expect(claims).toHaveLength(frameKeys(agents).length);
    expect(claims.every((c) => c.detector === 8)).toBe(true);
    expect(new Set(claims.map((c) => claimKey(c.runId, c.frameKey)))).toEqual(
      new Set(frameKeys(agents)),
    );
    const headline = countClaims(claims);
    expect(headline.totalMicros).toBe(
      BigInt(frameKeys(agents).length) * TURN_MICROS,
    );
    // The headline is the sum of the findings behind it.
    expect(headline.totalMicros).toBe(
      noOutcome.reduce((sum, f) => sum + f.savingMicros, 0n),
    );
    // A replay keys the same frames under the same findings.
    expect(replayClaims(input, new Set())).toEqual(claimsOf(findings));
  });

  it(`writes every counting finding past ${FINDINGS_PER_KIND} of a kind and ${FINDINGS_MAX} in all, and counts each claimed frame once`, () => {
    const { input, detectors, runs } = pastBothCaps();
    const findings = detectFindings(input, detectors);

    const expected = new Map<string, number>(
      [...DETECTOR_1_KINDS, "recurring_runs", "spend_with_no_outcome"].map(
        (kind) => [kind, PAST_THE_CAP],
      ),
    );
    expect(kindCounts(findings)).toEqual(expected);
    expect(findings.length).toBeGreaterThan(FINDINGS_MAX);

    // Every frame of every run is claimed once, so the headline adds each
    // frame once, and it equals the sum of the findings behind it.
    const claims = stored(findings);
    expect(claims).toHaveLength(frameKeys(runs).length);
    expect(new Set(claims.map((c) => claimKey(c.runId, c.frameKey)))).toEqual(
      new Set(frameKeys(runs)),
    );
    const headline = countClaims(claims).totalMicros;
    expect(headline).toBe(BigInt(frameKeys(runs).length) * TURN_MICROS);
    expect(headline).toBe(
      findings.reduce((sum, f) => sum + f.savingMicros, 0n),
    );
  });

  it("replays the claims of every counting group the pass keeps, under the same detectors", () => {
    const { input, detectors } = pastBothCaps();
    const findings = detectFindings(input, detectors);
    const replayed = replayClaims(input, new Set(), detectors);

    expect(replayed.size).toBe(counting(findings).length);
    expect(replayed).toEqual(claimsOf(findings));
  });

  it("still caps the advisory kinds, and the counting findings take none of their room", () => {
    // Advisory findings past both caps, each larger than every counting
    // finding: 12 of each of 6 kinds.
    const advisory = nonCounting(OTHER_KINDS, 10_000_000n, PAST_THE_CAP);
    const { input, detectors } = pastBothCaps([advisory]);
    const findings = detectFindings(input, detectors);

    // Every counting finding is written.
    expect(counting(findings)).toHaveLength(6 * PAST_THE_CAP);
    // The advisory findings keep at most `FINDINGS_PER_KIND` of each kind,
    // and `FINDINGS_MAX` in all. The 6 kinds hold 60 after the first cap, so
    // the second cuts the 10 smallest: every finding of the first kind.
    const kept = findings.filter((f) => f.claims === undefined);
    expect(kept).toHaveLength(FINDINGS_MAX);
    const perKind = kindCounts(kept);
    expect(perKind.has(OTHER_KINDS[0]!)).toBe(false);
    for (const kind of OTHER_KINDS.slice(1))
      expect(perKind.get(kind)).toBe(FINDINGS_PER_KIND);
    // Within each kind, the two smallest findings are the ones cut.
    const subjects = new Set(kept.map((f) => f.subject));
    for (const kind of OTHER_KINDS.slice(1)) {
      expect(subjects.has(`acme.${kind}.0`)).toBe(false);
      expect(subjects.has(`acme.${kind}.1`)).toBe(false);
      expect(subjects.has(`acme.${kind}.${PAST_THE_CAP - 1}`)).toBe(true);
    }
    // The advisory findings add nothing to the headline.
    expect(stored(kept)).toEqual([]);
  });

  it("keeps a recurring runs finding beside advisory findings that fill every advisory place", () => {
    const nightly = Array.from({ length: RECURRING_RUNS_MIN }, () =>
      run("acme.job.nightly"),
    );
    const input = reads({ jobs: { "sha256:nightly": nightly } });
    const detectors = [
      recurringRuns,
      spendWithNoOutcome,
      nonCounting(OTHER_KINDS.slice(0, 5), 10_000_000n),
    ];
    const findings = detectFindings(input, detectors);

    // 5 advisory kinds of 10 fill `FINDINGS_MAX`, and the recurring runs
    // finding takes no place among them.
    expect(findings).toHaveLength(FINDINGS_MAX + 1);
    const kept = findings.filter((f) => f.kind === "recurring_runs");
    expect(kept).toHaveLength(1);
    expect(kept[0]!.claims!.map((c) => c.detector)).toEqual(
      Array<number>(3 * RECURRING_RUNS_MIN).fill(7),
    );
    expect(
      new Set(stored(findings).map((c) => claimKey(c.runId, c.frameKey))),
    ).toEqual(new Set(frameKeys(nightly)));
    expect(countClaims(stored(findings)).totalMicros).toBe(
      BigInt(3 * RECURRING_RUNS_MIN) * TURN_MICROS,
    );
    expect(replayClaims(input, new Set(), detectors)).toEqual(
      claimsOf(findings),
    );
  });
});
