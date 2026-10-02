import {
  lineageIdSchema,
  proposalSupportSchema,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { describe, expect, it } from "vitest";
import { ZERO_TOKENS, type RunTotalsRecord } from "../cost-rollup";
import {
  detectFindings,
  findingFingerprint,
  instructionProposals,
  MIN_INSTRUCTION_RUNS,
  MIN_WHOLE_PROMPT_RUNS,
  promptRunsToPrice,
  PROPOSALS_PER_PASS,
  repeatsOf,
  sentencesOf,
  type DetectInput,
  type FindingDraft,
  type PricedRequestFrame,
  type PromptRead,
  type RunPrompt,
} from "./index";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date("2026-09-15T00:00:00.000Z");
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
/** What one model request costs in these tests, and the tokens it carries. */
const TURN_MICROS = 12_000n;
const TURN_TOKENS = 4_000;
const TESTS = "Run the unit tests before you open a pull request.";

let seq = 0;

function run(over: Partial<RunTotalsRecord> = {}): RunTotalsRecord {
  seq += 1;
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    runSource: "tacho",
    orgId: ORG,
    workspaceId: WS,
    operatorPrincipalId: null,
    operatorKey: OPERATOR,
    agentPrincipalId: null,
    agentKey: AGENT,
    taskRef: null,
    costCenter: null,
    startedAt: new Date(START.getTime() + seq * 60_000),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 2,
    modelCalls: 1,
    toolCalls: 0,
    tokens: { ...ZERO_TOKENS, input_uncached: 3_000 },
    costMicros: 9_000n,
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
    ...over,
  };
}

function at(minute: number): Date {
  return new Date(START.getTime() + minute * 60_000);
}

/** A prompt whose text the workspace keeps. */
function prompt(r: RunTotalsRecord, minute: number, text: string): RunPrompt {
  return {
    runId: r.runId,
    seq: minute,
    at: at(minute),
    digest: `sha256:${text.length}-${minute}`,
    length: text.length,
    text,
  };
}

/** A prompt the workspace keeps only the digest of. */
function digestOnly(
  r: RunTotalsRecord,
  minute: number,
  digest: string,
  length: number | null = 80,
): RunPrompt {
  return { runId: r.runId, seq: minute, at: at(minute), digest, length, text: null };
}

function frame(minute: number, costMicros: bigint | null): PricedRequestFrame {
  return {
    key: `${at(minute).toISOString()}#0`,
    at: at(minute),
    costMicros,
    tokens: TURN_TOKENS,
    basis: costMicros === null ? null : "gateway_observed",
  };
}

function read(
  mode: PromptRead["mode"],
  prompts: RunPrompt[],
  frames: Record<string, PricedRequestFrame[]> = {},
): PromptRead {
  return { mode, prompts, frames: new Map(Object.entries(frames)) };
}

function input(
  runs: RunTotalsRecord[],
  prompts: PromptRead | undefined,
  decidedSince: ReadonlyMap<string, Date> = new Map(),
): DetectInput {
  return {
    window: { start: START, end: END },
    toolWindowStart: START,
    runs,
    toolCalls: [],
    decidedSince,
    ...(prompts ? { prompts } : {}),
  };
}

function habits(i: DetectInput): FindingDraft[] {
  return detectFindings(i).filter((f) => f.kind === "repeated_instructions");
}

describe("sentencesOf", () => {
  it("splits on line breaks and on closing punctuation before a space", () => {
    expect(
      sentencesOf(
        "Fix the login bug on the settings page. Then run the whole suite!\nKeep every change inside the billing package?",
      ).map((s) => s.text),
    ).toEqual([
      "Fix the login bug on the settings page.",
      "Then run the whole suite!",
      "Keep every change inside the billing package?",
    ]);
  });

  it("drops list and quote markers, and skips code fences", () => {
    expect(
      sentencesOf(
        "- Use pnpm for every install step\n2. Read the README before editing\n> Quote the failing test by name\n```\nrun the tests in this fence\n```",
      ).map((s) => s.text),
    ).toEqual([
      "Use pnpm for every install step",
      "Read the README before editing",
      "Quote the failing test by name",
    ]);
  });

  it("keeps a sentence once, whatever its case or closing punctuation", () => {
    const out = sentencesOf(`${TESTS}\nrun the unit tests before you open a pull request`);
    expect(out).toEqual([
      { key: "run the unit tests before you open a pull request", text: TESTS },
    ]);
  });

  it("drops short replies, symbol runs, and pasted blocks", () => {
    const long = `Paste ${"word ".repeat(120)}end.`;
    expect(sentencesOf(`yes go on\n=> -> <= >= 1 2 3\n${long}`)).toEqual([]);
  });
});

describe("repeated instructions on a content_exact workspace", () => {
  it("turns an instruction repeated across runs into one proposal and one finding", () => {
    const [a, b, c] = [run(), run(), run()];
    const prompts = read(
      "content_exact",
      [
        prompt(a!, 1, `Fix the login bug on the settings page. ${TESTS}`),
        prompt(b!, 2, TESTS),
        prompt(c!, 3, `${TESTS} Keep the diff small.`),
        prompt(a!, 10, `Try again. ${TESTS}`),
      ],
      { [a!.runId]: [frame(4, TURN_MICROS), frame(6, TURN_MICROS), frame(11, TURN_MICROS)] },
    );
    const runs = [a!, b!, c!];

    const proposals = instructionProposals(prompts, runs);
    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p!.statement).toBe(TESTS);
    expect(p!.lineageId).toMatch(/^ctx\.habits\.instruction-[0-9a-f]{12}$/);
    expect(lineageIdSchema.parse(p!.lineageId)).toBe(p!.lineageId);
    expect(p!.runs).toEqual([a!.runId, b!.runId, c!.runId]);
    expect(p!.agents).toEqual([AGENT]);
    expect(p!.evidenceLinks).toEqual([
      `frame:${a!.runId}/1`,
      `frame:${b!.runId}/2`,
      `frame:${c!.runId}/3`,
      `frame:${a!.runId}/10`,
    ]);
    expect(p!.rationale).toBe(
      `Runs received "${TESTS}" 4 times in the last 30 days, across 3 runs. A steering record would reach every run it applies to with no paste.`,
    );
    expect(
      proposalSupportSchema.parse({
        runs: p!.runs,
        agents: p!.agents,
        recordIds: [],
        evidenceLinks: p!.evidenceLinks,
      }),
    ).toBeTruthy();

    const findings = habits(input(runs, prompts));
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f!.level).toBe("agent");
    expect(f!.subject).toBe(AGENT);
    expect(f!.fingerprint).toBe(
      findingFingerprint("repeated_instructions", "agent", AGENT),
    );
    // The later prompt answers the two turns since the run's first prompt.
    expect(f!.savingMicros).toBe(2n * TURN_MICROS);
    expect(f!.evidence.calls).toBe(4);
    expect(f!.evidence.coveredCalls).toBe(4);
    expect(f!.confidence).toBe("high");
    expect(f!.claims).toBeUndefined();
    expect(f!.evidence.frames?.[a!.runId]).toEqual({
      seqs: [{ seq: "1" }, { seq: "10" }],
      total: 2,
    });
    expect(f!.why).toBe(
      `Runs received "${TESTS}" 4 times this month. A steering record would reach every run it applies to with no paste.`,
    );
    expect(f!.fix).toContain("steering record proposal");
    expect(f!.why).not.toMatch(/waste|session|trace/i);
  });

  it("opens a proposal for a repeat no later prompt prices, and writes no finding", () => {
    const runs = [run(), run(), run()];
    const prompts = read(
      "content_exact",
      runs.map((r, i) => prompt(r, i + 1, TESTS)),
    );
    expect(instructionProposals(prompts, runs)).toHaveLength(1);
    expect(habits(input(runs, prompts))).toEqual([]);
  });

  it(`needs ${MIN_INSTRUCTION_RUNS} runs, not ${MIN_INSTRUCTION_RUNS} prompts`, () => {
    const [a, b] = [run(), run()];
    const prompts = read(
      "content_exact",
      [prompt(a!, 1, TESTS), prompt(a!, 5, TESTS), prompt(b!, 2, TESTS)],
      { [a!.runId]: [frame(3, 100_000n)] },
    );
    expect(repeatsOf(prompts, new Set([a!.runId, b!.runId]))).toEqual([]);
    expect(instructionProposals(prompts, [a!, b!])).toEqual([]);
    expect(habits(input([a!, b!], prompts))).toEqual([]);
  });

  it("prices a prompt with two repeated instructions once, and names the other", () => {
    const other = "Write the commit message in the imperative mood.";
    const [a, b, c] = [run(), run(), run()];
    const prompts = read(
      "content_exact",
      [
        prompt(a!, 1, `${TESTS} ${other}`),
        prompt(b!, 2, `${TESTS} ${other}`),
        prompt(c!, 3, `${other}\n${TESTS}`),
        prompt(a!, 10, TESTS),
      ],
      { [a!.runId]: [frame(5, TURN_MICROS)] },
    );
    const runs = [a!, b!, c!];
    const [f] = habits(input(runs, prompts));
    expect(f!.evidence.calls).toBe(4);
    expect(f!.savingMicros).toBe(TURN_MICROS);
    expect(f!.why).toContain(`"${TESTS}" 4 times`);
    expect(f!.why).toContain(
      "1 other instruction also reached 3 or more runs.",
    );
    expect(instructionProposals(prompts, runs).map((p) => p.statement)).toEqual(
      [TESTS, other],
    );
  });

  it("reports a repeat that reaches several agents on the workspace", () => {
    const a = run({ agentKey: "acme.core.triage" });
    const b = run({ agentKey: "acme.core.review" });
    const c = run({ agentKey: null, operatorKey: null });
    const prompts = read(
      "content_exact",
      [
        prompt(a, 1, TESTS),
        prompt(b, 2, TESTS),
        prompt(c, 3, TESTS),
        prompt(a, 10, TESTS),
      ],
      { [a.runId]: [frame(5, TURN_MICROS)] },
    );
    const [f] = habits(input([a, b, c], prompts));
    expect(f!.level).toBe("workspace");
    expect(f!.subject).toBe(WS);
    expect(instructionProposals(prompts, [a, b, c])[0]!.agents).toEqual([
      "acme.core.review",
      "acme.core.triage",
    ]);
  });

  it("reports on the workspace when the first run names no one", () => {
    const a = run({ agentKey: null, operatorKey: null });
    const b = run();
    const c = run();
    const prompts = read(
      "content_exact",
      [prompt(a, 1, TESTS), prompt(b, 2, TESTS), prompt(c, 3, TESTS), prompt(b, 10, TESTS)],
      { [b.runId]: [frame(5, TURN_MICROS)] },
    );
    const [f] = habits(input([a, b, c], prompts));
    expect(f!.level).toBe("workspace");
  });

  it("reports on the operator when every run names that operator and no agent", () => {
    const runs = [
      run({ agentKey: null }),
      run({ agentKey: null }),
      run({ agentKey: null }),
    ];
    const prompts = read(
      "content_exact",
      [...runs.map((r, i) => prompt(r, i + 1, TESTS)), prompt(runs[0]!, 10, TESTS)],
      { [runs[0]!.runId]: [frame(5, TURN_MICROS)] },
    );
    const [f] = habits(input(runs, prompts));
    expect(f!.level).toBe("operator");
    expect(f!.subject).toBe(OPERATOR);
  });

  it("leaves a span with an unpriced frame, or unread frames, uncovered", () => {
    const [a, b, c] = [run(), run(), run()];
    const prompts = read(
      "content_exact",
      [
        prompt(a!, 1, TESTS),
        prompt(b!, 2, TESTS),
        prompt(c!, 3, TESTS),
        prompt(a!, 10, TESTS),
        prompt(b!, 10, TESTS),
        prompt(c!, 10, TESTS),
      ],
      {
        [a!.runId]: [frame(5, 3n * TURN_MICROS)],
        [b!.runId]: [frame(5, TURN_MICROS), frame(6, null)],
      },
    );
    const [f] = habits(input([a!, b!, c!], prompts));
    expect(f!.evidence.calls).toBe(6);
    expect(f!.evidence.coveredCalls).toBe(4);
    expect(f!.confidence).toBe("medium");
    expect(f!.savingMicros).toBe(3n * TURN_MICROS);
  });

  it("counts only frames strictly between the two prompts", () => {
    const [a, b, c] = [run(), run(), run()];
    const prompts = read(
      "content_exact",
      [prompt(a!, 1, TESTS), prompt(b!, 2, TESTS), prompt(c!, 3, TESTS), prompt(a!, 10, TESTS)],
      {
        [a!.runId]: [
          frame(1, 100_000n),
          frame(4, TURN_MICROS),
          frame(10, 100_000n),
          frame(12, 100_000n),
        ],
      },
    );
    const [f] = habits(input([a!, b!, c!], prompts));
    expect(f!.savingMicros).toBe(TURN_MICROS);
  });

  it("quotes a long instruction in part and proposes it whole", () => {
    const long = `Always ${"check the migration journal and the schema index ".repeat(5)}first.`;
    const runs = [run(), run(), run()];
    const prompts = read(
      "content_exact",
      [...runs.map((r, i) => prompt(r, i + 1, long)), prompt(runs[0]!, 10, long)],
      { [runs[0]!.runId]: [frame(5, TURN_MICROS)] },
    );
    const [f] = habits(input(runs, prompts));
    expect(f!.why).toContain("…\"");
    expect(f!.why).not.toContain(long);
    expect(instructionProposals(prompts, runs)[0]!.statement).toBe(long);
  });

  it(`opens at most ${PROPOSALS_PER_PASS} proposals a pass, most repeated first`, () => {
    const runs = [run(), run(), run()];
    const lines = Array.from(
      { length: PROPOSALS_PER_PASS + 1 },
      (_, i) => `Keep rule number ${i} in every run.`,
    );
    const prompts = read(
      "content_exact",
      runs.map((r, i) => prompt(r, i + 1, lines.join("\n"))),
    );
    expect(instructionProposals(prompts, runs)).toHaveLength(PROPOSALS_PER_PASS);
  });

  it("skips a prompt with no text", () => {
    const runs = [run(), run(), run()];
    const prompts = read("content_exact", [
      prompt(runs[0]!, 1, TESTS),
      prompt(runs[1]!, 2, TESTS),
      { ...prompt(runs[2]!, 3, TESTS), text: null },
    ]);
    expect(instructionProposals(prompts, runs)).toEqual([]);
  });

  it("cites no run a person already decided the finding for", () => {
    const runs = [run(), run(), run()];
    const prompts = read(
      "content_exact",
      [...runs.map((r, i) => prompt(r, i + 1, TESTS)), prompt(runs[0]!, 10, TESTS)],
      { [runs[0]!.runId]: [frame(5, TURN_MICROS)] },
    );
    const decided = new Map([
      [findingFingerprint("repeated_instructions", "agent", AGENT), END],
    ]);
    expect(habits(input(runs, prompts, decided))).toEqual([]);
  });

  // #4579: every pass picked the same first 20, and the opener refused them
  // all as taken, so the 21st instruction never got a proposal.
  it(`opens proposals past the first ${PROPOSALS_PER_PASS} once those lineages are taken`, () => {
    const runs = [run(), run(), run()];
    const lines = Array.from(
      { length: PROPOSALS_PER_PASS + 5 },
      (_, i) => `Keep rule number ${i} in every run.`,
    );
    const prompts = read(
      "content_exact",
      runs.map((r, i) => prompt(r, i + 1, lines.join("\n"))),
    );
    const first = instructionProposals(prompts, runs);
    expect(first).toHaveLength(PROPOSALS_PER_PASS);

    const taken = new Set(first.map((p) => p.lineageId));
    const next = instructionProposals(prompts, runs, { taken });
    expect(next).toHaveLength(5);
    expect(next.filter((p) => taken.has(p.lineageId))).toEqual([]);
    expect(new Set([...first, ...next].map((p) => p.statement))).toEqual(
      new Set(lines),
    );
    expect(
      instructionProposals(prompts, runs, {
        taken: new Set([...first, ...next].map((p) => p.lineageId)),
      }),
    ).toEqual([]);
  });

  // #4579: the proposal read every run in the window, so a dismissed
  // finding's proposal could still open from the runs the dismissal covered.
  it("opens no proposal from runs a dismissal covers, and one from enough later runs", () => {
    const before = [run(), run(), run()];
    const dismissed = new Date(before[2]!.startedAt.getTime() + 30_000);
    const decidedSince = new Map([
      [findingFingerprint("repeated_instructions", "agent", AGENT), dismissed],
    ]);
    const proposalsFor = (runs: RunTotalsRecord[]) =>
      instructionProposals(
        read(
          "content_exact",
          runs.map((r, i) => prompt(r, i + 1, TESTS)),
        ),
        runs,
        { decidedSince },
      );

    expect(
      instructionProposals(
        read(
          "content_exact",
          before.map((r, i) => prompt(r, i + 1, TESTS)),
        ),
        before,
      ),
    ).toHaveLength(1);
    expect(proposalsFor(before)).toEqual([]);

    const after = [run(), run(), run()];
    expect(proposalsFor([...before, ...after.slice(0, 2)])).toEqual([]);
    const [p, ...rest] = proposalsFor([...before, ...after]);
    expect(rest).toEqual([]);
    expect(p!.runs).toEqual(after.map((r) => r.runId));
    expect(p!.evidenceLinks).toEqual(
      after.map((r, i) => `frame:${r.runId}/${i + 4}`),
    );
    expect(p!.rationale).toContain("3 times in the last 30 days, across 3 runs");
  });

  // #4579: a run from a second agent moved the key to the workspace, which
  // has no decision, and brought the covered runs back.
  it("keeps runs a dismissal covered out of a later finding and proposal under another key", () => {
    const before = [run(), run(), run()];
    const dismissed = new Date(before[2]!.startedAt.getTime() + 30_000);
    const decidedSince = new Map([
      [findingFingerprint("repeated_instructions", "agent", AGENT), dismissed],
    ]);
    const other = run({ agentKey: "acme.core.review" });
    const runs = [...before, other];
    const prompts = read(
      "content_exact",
      [...runs.map((r, i) => prompt(r, i + 1, TESTS)), prompt(other, 10, TESTS)],
      { [other.runId]: [frame(5, TURN_MICROS)] },
    );

    expect(instructionProposals(prompts, runs, { decidedSince })).toEqual([]);
    const findings = habits(input(runs, prompts, decidedSince));
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f!.level).toBe("agent");
    expect(f!.subject).toBe("acme.core.review");
    expect(f!.citedRuns).toEqual([other.runId]);
    expect(f!.evidence.calls).toBe(2);
  });

  it("ignores prompts of runs the pass did not read", () => {
    const runs = [run(), run(), run()];
    const stray = run();
    const prompts = read("content_exact", [
      prompt(runs[0]!, 1, TESTS),
      prompt(runs[1]!, 2, TESTS),
      prompt(stray, 3, TESTS),
    ]);
    expect(instructionProposals(prompts, runs)).toEqual([]);
    expect(habits(input(runs, prompts))).toEqual([]);
  });
});

describe("whole-prompt repeats on a digest_only workspace", () => {
  it("groups two runs with the same prompt digest into one repeat that needs prompt text", () => {
    const [a, b] = [run(), run()];
    const prompts = read(
      "digest_only",
      [
        digestOnly(a!, 1, "sha256:first"),
        digestOnly(b!, 2, "sha256:same"),
        digestOnly(a!, 10, "sha256:same"),
      ],
      { [a!.runId]: [frame(5, TURN_MICROS)] },
    );
    const repeats = repeatsOf(prompts, new Set([a!.runId, b!.runId]));
    expect(MIN_WHOLE_PROMPT_RUNS).toBe(2);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.digest).toBe("sha256:same");
    expect(repeats[0]!.text).toBeNull();

    const [f] = habits(input([a!, b!], prompts));
    expect(f!.why).toBe(
      "Runs received the same prompt 2 times this month, across 2 runs. Needs prompt text: this workspace keeps only a digest of each prompt, so the sentences that repeat cannot be shown.",
    );
    expect(f!.fix).toContain("retention policy");
    expect(f!.claims).toBeUndefined();
    expect(instructionProposals(prompts, [a!, b!])).toEqual([]);
  });

  it("names the other repeated prompts", () => {
    const [a, b] = [run(), run()];
    const prompts = read(
      "digest_only",
      [
        digestOnly(a!, 1, "sha256:one"),
        digestOnly(b!, 2, "sha256:one"),
        digestOnly(b!, 3, "sha256:two"),
        digestOnly(a!, 10, "sha256:two", null),
      ],
      { [a!.runId]: [frame(5, TURN_MICROS)] },
    );
    const [f] = habits(input([a!, b!], prompts));
    expect(f!.why).toContain("1 other prompt also repeated.");
  });

  it("skips a prompt too short to be an instruction", () => {
    const [a, b] = [run(), run()];
    const prompts = read("digest_only", [
      digestOnly(a!, 1, "sha256:yes", 3),
      digestOnly(b!, 2, "sha256:yes", 3),
    ]);
    expect(repeatsOf(prompts, new Set([a!.runId, b!.runId]))).toEqual([]);
  });
});

describe("promptRunsToPrice", () => {
  it("names the runs with a later repeat, most such prompts first", () => {
    const [a, b, c] = [run(), run(), run()];
    const prompts = read("content_exact", [
      prompt(a!, 1, TESTS),
      prompt(b!, 2, TESTS),
      prompt(c!, 3, TESTS),
      prompt(b!, 10, TESTS),
      prompt(c!, 11, TESTS),
      prompt(c!, 12, TESTS),
    ]);
    const ids = new Set([a!.runId, b!.runId, c!.runId]);
    expect(promptRunsToPrice(prompts, ids, 5)).toEqual([c!.runId, b!.runId]);
    expect(promptRunsToPrice(prompts, ids, 1)).toEqual([c!.runId]);
  });
});

describe("a pass with no prompt read", () => {
  it("writes no finding and opens no proposal", () => {
    const runs = [run()];
    expect(habits(input(runs, undefined))).toEqual([]);
    expect(instructionProposals(undefined, runs)).toEqual([]);
  });
});
