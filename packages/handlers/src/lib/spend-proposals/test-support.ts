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
  "On 2 runs, a call ran 20 or more times in a row and returned the same result each time. 140 turns made only those repeats.";

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
