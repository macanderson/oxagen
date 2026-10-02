/**
 * The findings caps and the unproductive spend headline (#5050). A finding
 * the caps cut is not written, so its claims are not stored. These tests
 * check that every frame a written finding claims is counted once, and that
 * a frame no written finding claims is free for a later counting detector.
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
  DETECTORS,
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
/** Five kinds no counting detector writes. */
const OTHER_KINDS: readonly FindingKind[] = [
  "cache_busts",
  "unpaged_results",
  "standing_context",
  "cache_writes_never_read",
  "idle_cache_rewrites",
];

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

/** `FINDINGS_PER_KIND` recurring jobs, one agent each. */
function recurringJobs(): Record<string, RunTotalsRecord[]> {
  const jobs: Record<string, RunTotalsRecord[]> = {};
  for (let i = 0; i < FINDINGS_PER_KIND; i += 1)
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
 * A detector that claims no frame: `FINDINGS_PER_KIND` findings of each kind
 * it names, each saving at least `saving`. The finding at index i saves i
 * micros more, so the smallest is index 0.
 */
function nonCounting(kinds: readonly FindingKind[], saving: bigint): Detector {
  const r = run("acme.other");
  return {
    kinds,
    counting: null,
    detect(input, ctx) {
      for (const kind of kinds)
        for (let i = 0; i < FINDINGS_PER_KIND; i += 1)
          ctx.groups.add(
            { kind, level: "agent", subject: `acme.${kind}.${i}` },
            input.window.start,
            r,
            {
              measuredTokens: 1,
              counterfactualTokens: 0,
              micros: { measured: saving + BigInt(i), counterfactual: 0n },
            },
            null,
          );
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

describe("the findings caps and the headline (#5050)", () => {
  it(`fits every counting kind before detector 8 under ${FINDINGS_MAX}`, () => {
    // Detector 1 writes four kinds and detector 7 one, so their findings fill
    // `FINDINGS_MAX` at most. Only detector 8, which runs last, can be cut by
    // it, and no later detector could claim its frames anyway.
    const before8 = DETECTORS.filter(
      (d) => d.counting !== null && d.counting !== 8,
    ).flatMap((d) => d.kinds);
    expect(before8).toHaveLength(5);
    expect(before8.length * FINDINGS_PER_KIND).toBeLessThanOrEqual(
      FINDINGS_MAX,
    );
  });

  it(`keeps a recurring runs finding that ${FINDINGS_MAX} larger findings of other kinds would have cut`, () => {
    const nightly = Array.from({ length: RECURRING_RUNS_MIN }, () =>
      run("acme.job.nightly"),
    );
    const input = reads({ jobs: { "sha256:nightly": nightly } });
    const others = nonCounting(OTHER_KINDS, 10_000_000n);
    const findings = detectFindings(input, [
      recurringRuns,
      spendWithNoOutcome,
      others,
    ]);

    expect(findings).toHaveLength(FINDINGS_MAX);
    const kept = findings.filter((f) => f.kind === "recurring_runs");
    expect(kept).toHaveLength(1);
    expect(kept[0]!.claims!.map((c) => c.detector)).toEqual(
      Array<number>(3 * RECURRING_RUNS_MIN).fill(7),
    );
    // One of the smallest findings of the other kinds made room for it.
    const shown = new Set(findings.map((f) => f.subject));
    const left = OTHER_KINDS.flatMap((kind) =>
      Array.from({ length: FINDINGS_PER_KIND }, (_, i) => `acme.${kind}.${i}`),
    ).filter((subject) => !shown.has(subject));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/\.0$/);
    // The headline counts each of the job's frames once.
    expect(
      new Set(stored(findings).map((c) => claimKey(c.runId, c.frameKey))),
    ).toEqual(new Set(frameKeys(nightly)));
    expect(countClaims(stored(findings)).totalMicros).toBe(
      BigInt(3 * RECURRING_RUNS_MIN) * TURN_MICROS,
    );
    expect(
      replayClaims(input, new Set(), [recurringRuns, spendWithNoOutcome]),
    ).toEqual(claimsOf(findings));
  });

  it(`frees the frames of a spend with no outcome finding past ${FINDINGS_MAX}, and counts every frame it keeps once`, () => {
    const byKind = new Map(
      DETECTOR_1_KINDS.map((kind) => [
        kind,
        Array.from({ length: FINDINGS_PER_KIND }, (_, i) =>
          run(`acme.${kind}.${i}`),
        ),
      ]),
    );
    const looped = [...byKind.values()].flat();
    const jobs = recurringJobs();
    const lone = run("acme.lone");
    const input = reads({ jobs, closed: [lone], others: looped });
    const detectors = [
      detector1(byKind),
      recurringRuns,
      spendWithNoOutcome,
      // Larger than every counting finding, and still left out: the counting
      // findings filled every place.
      nonCounting(["cache_busts"], 10_000_000n),
    ];
    const findings = detectFindings(input, detectors);

    expect(findings).toHaveLength(FINDINGS_MAX);
    const kinds = new Map<string, number>();
    for (const f of findings) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    const expected = new Map<string, number>(
      DETECTOR_1_KINDS.map((k) => [k, FINDINGS_PER_KIND]),
    );
    expected.set("recurring_runs", FINDINGS_PER_KIND);
    expect(kinds).toEqual(expected);

    // Every kept frame is claimed once. The lone run's frames belong to no
    // written finding, so none of them is claimed.
    const claims = stored(findings);
    const kept = [...looped, ...Object.values(jobs).flat()];
    expect(claims).toHaveLength(frameKeys(kept).length);
    expect(new Set(claims.map((c) => claimKey(c.runId, c.frameKey)))).toEqual(
      new Set(frameKeys(kept)),
    );
    expect(countClaims(claims).totalMicros).toBe(
      BigInt(frameKeys(kept).length) * TURN_MICROS,
    );
    // The replay cuts the same finding and keys the same frames under the
    // same detectors.
    expect(replayClaims(input, new Set(), detectors)).toEqual(
      claimsOf(findings),
    );
  });

  it("gives a spend with no outcome finding its place when the counting findings leave room", () => {
    const jobs = recurringJobs();
    const lone = run("acme.lone");
    const input = reads({ jobs, closed: [lone] });
    const findings = detectFindings(input, [
      recurringRuns,
      spendWithNoOutcome,
      nonCounting(OTHER_KINDS, 10_000_000n),
    ]);

    expect(findings).toHaveLength(FINDINGS_MAX);
    const noOutcome = findings.filter(
      (f) => f.kind === "spend_with_no_outcome",
    );
    expect(noOutcome.map((f) => f.subject)).toEqual(["acme.lone"]);
    // 11 counting findings leave 39 places for the 50 others.
    expect(findings.filter((f) => OTHER_KINDS.includes(f.kind))).toHaveLength(
      FINDINGS_MAX - FINDINGS_PER_KIND - 1,
    );
    expect(countClaims(stored(findings)).totalMicros).toBe(
      BigInt(frameKeys([...Object.values(jobs).flat(), lone]).length) *
        TURN_MICROS,
    );
  });
});
