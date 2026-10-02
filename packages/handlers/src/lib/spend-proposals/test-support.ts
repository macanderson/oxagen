/**
 * test-support.ts — finding drafts and instruction proposals for the
 * spend-proposals tests, shaped as the findings pass writes them.
 */
import type {
  FindingDraft,
  InstructionProposal,
} from "@oxagen/billing/proposal-opener";

export const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

export const SUBAGENT_CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000aa";

const SPIN_WHY =
  "On 2 runs, a call ran 20 or more times in a row and returned the same result each time. 140 calls came from turns that made only those repeats.";

/**
 * One agent's `spin_loops` finding over two runs. Run `tse_a` looped on its
 * own chain, and run `tse_b` looped on a subagent's chain.
 */
export function spinDraft(
  subject: string,
  over: Partial<FindingDraft> = {},
): FindingDraft {
  return {
    kind: "spin_loops",
    level: "agent",
    subject,
    fingerprint: `spin_loops|agent|${subject}`,
    windowStart: new Date("2026-09-01T00:00:00.000Z"),
    windowEnd: new Date("2026-10-01T00:00:00.000Z"),
    savingMicros: 12_400_000n,
    currency: "USD",
    basis: "gateway_observed",
    confidence: "high",
    why: SPIN_WHY,
    fix: "Tell the agent to change its approach when a call returns the same result twice.",
    citedRuns: ["tse_a", "tse_b"],
    evidence: {
      calls: 140,
      coveredCalls: 140,
      measuredTokens: 2_800_000,
      counterfactualTokens: 0,
      measuredMicros: "12400000",
      counterfactualMicros: "0",
      operatorKeys: ["prn_0123456789abcdefghjkmn"],
      runs: [
        {
          runId: "tse_a",
          startedAt: "2026-09-10T10:00:00.000Z",
          calls: 90,
          measuredTokens: 1_800_000,
          counterfactualTokens: 0,
          measuredMicros: "8000000",
          counterfactualMicros: "0",
        },
        {
          runId: "tse_b",
          startedAt: "2026-09-12T10:00:00.000Z",
          calls: 50,
          measuredTokens: 1_000_000,
          counterfactualTokens: 0,
          measuredMicros: "4400000",
          counterfactualMicros: "0",
        },
      ],
      frames: {
        tse_a: { seqs: [{ seq: "12" }, { seq: "13" }], total: 90 },
        tse_b: {
          seqs: [{ seq: "4", sessionUuid: SUBAGENT_CHAIN }],
          total: 50,
        },
      },
    },
    ...over,
  };
}

/** One repeated instruction, as detector 6 writes its proposal. */
export function instruction(n: number): InstructionProposal {
  return {
    lineageId: `ctx.habits.instruction-00000000000${n}`,
    statement: `Run the unit tests before you open pull request ${n}.`,
    rationale: `Runs received it ${n} times.`,
    runs: ["run_a", "run_b", "run_c"],
    agents: ["agent.reviewer"],
    evidenceLinks: ["frame:run_a/1", "frame:run_b/4"],
  };
}

/**
 * One agent's `model_class_fit` finding over three runs that changed no
 * file, as detector 4 writes it. The figure is an estimate and cites whole
 * runs, so it pins no frame.
 */
export function classDraft(
  subject: string,
  over: Partial<FindingDraft> = {},
): FindingDraft {
  return {
    kind: "model_class_fit",
    level: "agent",
    subject,
    fingerprint: `model_class_fit|agent|${subject}`,
    windowStart: new Date("2026-09-01T00:00:00.000Z"),
    windowEnd: new Date("2026-10-01T00:00:00.000Z"),
    savingMicros: 2_790_000n,
    currency: "USD",
    basis: "estimated",
    confidence: "high",
    why: "3 runs changed no file. Repriced from claude-opus-5 to claude-sonnet-5 at list prices, they would have cost an estimated 31% less.",
    fix: "Route tasks that only read to claude-sonnet-5 with a model-route steering record, or lower their effort. Replay a sample on the smaller class to confirm the estimate before you move them.",
    citedRuns: ["tse_r1", "tse_r2", "tse_r3"],
    evidence: {
      calls: 3,
      coveredCalls: 3,
      measuredTokens: 900_000,
      counterfactualTokens: 900_000,
      measuredMicros: "9000000",
      counterfactualMicros: "6210000",
      operatorKeys: ["prn_0123456789abcdefghjkmn"],
      runs: ["tse_r1", "tse_r2", "tse_r3"].map((runId, i) => ({
        runId,
        startedAt: `2026-09-1${i}T10:00:00.000Z`,
        calls: 1,
        measuredTokens: 300_000,
        counterfactualTokens: 300_000,
        measuredMicros: "3000000",
        counterfactualMicros: "2070000",
      })),
    },
    ...over,
  };
}

/**
 * One tool's `unpaged_results` finding over two runs, as detector 5 writes
 * it. Run `tse_c` carried three large results on its own chain, and run
 * `tse_d` carried one on a subagent's chain.
 */
export function unpagedDraft(
  subject: string,
  over: Partial<FindingDraft> = {},
): FindingDraft {
  return {
    kind: "unpaged_results",
    level: "tool",
    subject,
    fingerprint: `unpaged_results|tool|${subject}`,
    windowStart: new Date("2026-09-01T00:00:00.000Z"),
    windowEnd: new Date("2026-10-01T00:00:00.000Z"),
    savingMicros: 1_080_000n,
    currency: "USD",
    basis: "gateway_observed",
    confidence: "high",
    why: `${subject} returned 4 results over 5,000 tokens on 2 runs. Later requests read them 60 times.`,
    fix: `Page ${subject}'s results at 4,000 tokens and fetch the rest on demand. A step that needs a large result once can run in a subagent, so the result stays out of the run's own context.`,
    citedRuns: ["tse_c", "tse_d"],
    evidence: {
      calls: 60,
      coveredCalls: 60,
      measuredTokens: 600_000,
      counterfactualTokens: 240_000,
      measuredMicros: "1800000",
      counterfactualMicros: "720000",
      operatorKeys: ["prn_0123456789abcdefghjkmn"],
      runs: [
        {
          runId: "tse_c",
          startedAt: "2026-09-14T10:00:00.000Z",
          calls: 45,
          measuredTokens: 450_000,
          counterfactualTokens: 180_000,
          measuredMicros: "1350000",
          counterfactualMicros: "540000",
        },
        {
          runId: "tse_d",
          startedAt: "2026-09-15T10:00:00.000Z",
          calls: 15,
          measuredTokens: 150_000,
          counterfactualTokens: 60_000,
          measuredMicros: "450000",
          counterfactualMicros: "180000",
        },
      ],
      frames: {
        tse_c: { seqs: [{ seq: "7" }, { seq: "19" }, { seq: "31" }], total: 3 },
        tse_d: {
          seqs: [{ seq: "2", sessionUuid: SUBAGENT_CHAIN }],
          total: 1,
        },
      },
    },
    ...over,
  };
}

/**
 * One agent's `recurring_runs` finding, as detector 7 writes it: five runs
 * started with the same prompt, and the three cited runs changed nothing.
 * It cites whole runs, so it pins no frame.
 */
export function recurringDraft(
  subject: string,
  over: Partial<FindingDraft> = {},
): FindingDraft {
  return {
    kind: "recurring_runs",
    level: "agent",
    subject,
    fingerprint: `recurring_runs|agent|${subject}`,
    windowStart: new Date("2026-09-01T00:00:00.000Z"),
    windowEnd: new Date("2026-10-01T00:00:00.000Z"),
    savingMicros: 3_200_000n,
    currency: "USD",
    basis: "gateway_observed",
    confidence: "high",
    why: "5 runs started with the same prompt in the last 30 days. 3 of them changed nothing. A run changed nothing when it made no mutating call and changed no file.",
    fix: "Start the job on a change, such as a new commit or a new issue, instead of on a clock. If it must run on a clock, run it less often or move it to a smaller model class. If it calls the model API directly and can wait, send it as a batch at half price.",
    citedRuns: ["tse_j1", "tse_j2", "tse_j3"],
    evidence: {
      calls: 24,
      coveredCalls: 24,
      measuredTokens: 480_000,
      counterfactualTokens: 0,
      measuredMicros: "3200000",
      counterfactualMicros: "0",
      operatorKeys: ["prn_0123456789abcdefghjkmn"],
      runs: ["tse_j1", "tse_j2", "tse_j3"].map((runId, i) => ({
        runId,
        startedAt: `2026-09-2${i}T06:00:00.000Z`,
        calls: 8,
        measuredTokens: 160_000,
        counterfactualTokens: 0,
        measuredMicros: i === 0 ? "1066668" : "1066666",
        counterfactualMicros: "0",
      })),
    },
    ...over,
  };
}
