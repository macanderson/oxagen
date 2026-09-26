// Typed Run values for the Run component tests (ARCHITECTURE.md §5): the
// detail read, its frames, the cost rollup, a transcript, and a DataSource
// that answers the Run page's reads with what a test hands it. Importable from
// tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type {
  RunChain,
  RunCost,
  RunDetail,
  RunFrame,
  RunFrameBody,
  RunOutputNode,
  RunOutputs,
  RunTranscript,
  RunTurns,
  TranscriptBody,
  TranscriptCounts,
  TranscriptEntry,
  TranscriptFigures,
  TranscriptZoom,
} from "@/data/contracts/run";
import type {
  ApprovalQueue,
  ResolvedApprovals,
} from "@/data/contracts/approvals";
import type { MandateList } from "@/data/contracts/mandates";
import type { RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { PriceBook } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { countsAsError, frameFolds, tachoFrame } from "@oxagen/run-ledger";
import type { AgentDetail, AgentPage } from "@/data/contracts/agents";
import { type Read, readOk } from "@/data/read";

/** The instant every Run test renders at. */
export const NOW = Date.parse("2026-09-15T09:00:00.000Z");

const at = (secondsFromNow: number): string =>
  new Date(NOW + secondsFromNow * 1000).toISOString();

/** A figure the gateway observed, in USD micros. */
const gatewayUsd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});

export function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "tse_7k2m9q",
    source: "tacho",
    agentKey: "acme.core.release-bot",
    operatorId: "prn_marcusbell",
    operatorKind: "human",
    operatorName: "Marcus Bell",
    status: "sealed",
    outcome: "completed",
    turns: 12,
    steps: 96,
    frames: 431,
    cost: { micros: "4131265", currency: "USD", basis: "gateway_observed" },
    model: {
      slug: "claude-sonnet-5",
      provider: "anthropic",
      tier: "sonnet",
    },
    harness: { name: "Claude Code", version: "2.1.0", runtime: "claude-code" },
    machine: {
      hostname: "mac-studio.local",
      platform: "darwin",
      osVersion: "15.6",
      arch: "arm64",
      nodeVersion: "v24.4.0",
    },
    taskRef: "ENG-4121 cut the 3.2 release",
    name: "Cut the 3.2 release branch",
    summary: {
      text: "Cut release/3.2 from main, bumped eleven package versions, and opened the release pull request.",
      generatedAt: at(-120),
      model: "z-ai/glm-flash-latest",
    },
    replayGrade: "fork",
    verdict: "flipped",
    enforcementTier: "harness",
    completenessGaps: [],
    canSummarize: true,
    startedAt: at(-3600),
    sealedAt: at(-300),
    ...overrides,
  };
}

export function runChain(overrides: Partial<RunChain> = {}): RunChain {
  return {
    hashRule: "tacho.sha256_prev_hash_v1",
    frameCount: 431,
    firstSeq: "1",
    lastSeq: "431",
    merkleRoot: `sha256:${"c".repeat(64)}`,
    checkpoints: [
      {
        seq: "200",
        chainHead: `sha256:${"d".repeat(64)}`,
        eventCount: 200,
        signedAt: at(-1800),
        deviceKeyFingerprint: "ed25519:2f:91:aa",
        platformKey: "pk_01k4qj9e",
        countersignedAt: at(-1790),
        anchorRoot: null,
        anchoredAt: null,
      },
    ],
    gaps: {
      missingSequences: [],
      missingFrameCount: 0,
      missingBodies: 0,
      recorded: [],
    },
    seals: [
      {
        sealedAt: at(-300),
        terminalStatus: "completed",
        eventCount: 431,
        finalRunSeq: "431",
        finalEventDigest: `sha256:${"e".repeat(64)}`,
        eventStreamDigest: `sha256:${"f".repeat(64)}`,
        merkleRoot: `sha256:${"c".repeat(64)}`,
        archiveSegmentRef: null,
      },
    ],
    enforcementTier: "harness",
    recordedGrade: "fork",
    ladder: [
      { grade: "inspect", met: true, reason: "frames_recorded" },
      { grade: "view", met: true, reason: "bodies_retained" },
      { grade: "fork", met: true, reason: "tool_cassette_complete" },
      { grade: "retry", met: false, reason: "harness_not_reproducible" },
    ],
    complete: true,
    ...overrides,
  };
}

export function runFrame(overrides: Partial<RunFrame> = {}): RunFrame {
  return {
    cursor: "ZjoxMQ",
    seq: "11",
    type: "model.call_completed",
    stage: "act",
    observedAt: at(-3000),
    digest: "sha256:5f2d1c8a",
    summary: "anthropic · claude-opus-5 · ok",
    tool: null,
    toolStatus: null,
    approvalId: null,
    body: {
      digest: "sha256:9a1b4e7c",
      bytesRef: "blob://runs/tse_7k2m9q/11",
      redactions: [],
      fidelity: "full",
    },
    cost: { micros: "18240", currency: "USD", basis: "gateway_observed" },
    ...overrides,
  };
}

export function runDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run: runRow(),
    frames: { frames: [runFrame()], cursor: null, more: false },
    witnessed: false,
    ...overrides,
  };
}

export function runFrameBody(
  overrides: Partial<RunFrameBody> = {},
): RunFrameBody {
  return {
    seq: "11",
    contentType: "application/json",
    text: '{"model":"claude-opus-5","messages":[{"role":"user","content":"Cut release/3.2 from main."}]}',
    bytes: 92,
    digest: "sha256:9a1b4e7c",
    redactions: [],
    ...overrides,
  };
}

/** One half of the exchange, with its body retained and readable. */
export function transcriptBody(
  overrides: Partial<TranscriptBody> = {},
): TranscriptBody {
  return {
    seq: "11",
    type: "model.call_completed",
    digest: `sha256:${"a".repeat(64)}`,
    bytesRef: "evb:v1:k:abc",
    redactions: [],
    fidelity: "full",
    text: "Cutting release/3.2 from main.",
    truncated: false,
    ...overrides,
  };
}

/**
 * One transcript entry: by default a model step that answered, with the facts
 * the server's fold states about it. The entry's key follows its opening
 * frame, as the server names it (`frameKey`), unless a test names it.
 */
export function transcriptEntry(
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  const kinds = overrides.kinds ?? ["responses"];
  const outcome = overrides.outcome === undefined ? "ok" : overrides.outcome;
  const entry: Omit<TranscriptEntry, "key"> = {
    seq: "11",
    endSeq: "14",
    at: at(-3000),
    elapsedMs: 3000,
    kind: "model_call",
    type: "model.call_completed",
    label: "claude-opus-5",
    callKey: null,
    kinds: ["responses"],
    request: null,
    response: transcriptBody(),
    decision: null,
    frames: 4,
    turn: 1,
    cost: { micros: "18240", currency: "USD", basis: "gateway_observed" },
    cumulativeCost: {
      micros: "18240",
      currency: "USD",
      basis: "gateway_observed",
    },
    parentKey: null,
    node: "model",
    quiet: false,
    outcome: "ok",
    // What the server states, by its own rule, unless the fixture says
    // otherwise: an entry that failed, was refused or answers the errors
    // chip is an error.
    error: countsAsError({ outcome, kinds: new Set(kinds) }),
    approvalId: null,
    gates: [],
    subject: null,
    family: null,
    model: "anthropic/claude-opus-5",
    durationMs: null,
    echoOf: null,
    recall: null,
    matches: [],
    ...overrides,
  };
  return {
    ...entry,
    key:
      overrides.key ??
      (entry.subagent === undefined
        ? entry.seq
        : `${entry.subagent.chainRef}:${entry.seq}`),
  };
}

/**
 * A wrapped run read at `everything`, shaped like the mockup's release run:
 * the agent starting, then two turns, each opening on the operator's prompt
 * and closing on the agent's reply, with a model call, an allowed tool call,
 * and in the second turn a tool call the policy denied.
 */
export function mockupTranscript(
  overrides: Partial<RunTranscript> = {},
): RunTranscript {
  /**
   * One frame of the run, at `everything`. A frame carries one half of an
   * exchange: the phase it was recorded in decides whether its body is what
   * went out or what came back.
   */
  type Spec = {
    seq: number;
    type: string;
    kind: TranscriptEntry["kind"];
    label: string;
    turn: number | null;
    text?: string;
    fidelity?: TranscriptBody["fidelity"];
    costMicros?: string;
    decision?: string;
  };
  const REQUEST_TYPES = new Set([
    "model.request",
    "model.engine_call_started",
    "tool_requested",
    "tool.engine_call_started",
  ]);
  const specs: Spec[] = [
    {
      seq: 0,
      type: "agent_start",
      kind: "frame",
      label: "agent_start",
      turn: null,
    },
    {
      seq: 1,
      type: "context.assembled",
      kind: "frame",
      label: "context.assembled",
      turn: null,
    },
    {
      seq: 2,
      type: "turn_start",
      kind: "frame",
      label: "turn_start",
      turn: 1,
      text: "Cut the 2026.9.2 release candidate.",
    },
    {
      seq: 3,
      type: "model.request",
      kind: "model_call",
      label: "anthropic/claude-fable-5-1",
      turn: 1,
    },
    {
      seq: 4,
      type: "model.response",
      kind: "model_call",
      label: "anthropic/claude-fable-5-1",
      turn: 1,
      text: "I will list the open pull requests first.",
      costMicros: "380000",
    },
    {
      seq: 5,
      type: "tool_requested",
      kind: "tool_call",
      label: "list_pull_requests",
      turn: 1,
    },
    {
      seq: 6,
      type: "policy_decision",
      kind: "frame",
      label: "policy allow",
      turn: 1,
      decision: "allow",
    },
    {
      seq: 7,
      type: "tool_call",
      kind: "tool_call",
      label: "list_pull_requests ok",
      turn: 1,
      text: '{"open":34}',
    },
    {
      seq: 8,
      type: "turn_end",
      kind: "frame",
      label: "turn_end",
      turn: 1,
      text: "Both failures predate the release scope.",
    },
    {
      seq: 9,
      type: "turn_start",
      kind: "frame",
      label: "turn_start",
      turn: 2,
      text: "Tag the release candidate.",
    },
    {
      seq: 10,
      type: "llm_call",
      kind: "model_call",
      label: "anthropic/claude-fable-5-1",
      turn: 2,
      costMicros: "520000",
      fidelity: "digest_only",
    },
    {
      seq: 11,
      type: "tool_requested",
      kind: "tool_call",
      label: "create_tag",
      turn: 2,
    },
    {
      seq: 12,
      type: "policy_decision",
      kind: "frame",
      label: "policy deny",
      turn: 2,
      decision: "deny",
    },
  ];
  // What the server's fold states about each frame read as its own entry
  // (`frameFolds`, the `everything` zoom): its chips, its node, whether it
  // draws nothing, its outcome and the tool it is about. The frames are the
  // specs recorded as a wrapped session's rows, so no fact here is stated by
  // a second copy of the server's rules.
  const folds = frameFolds(
    specs.map((spec) =>
      tachoFrame({
        seq: spec.seq,
        ts: at(-3600 + spec.seq * 2),
        kind: spec.type,
        hash: "",
        contentDigest:
          spec.text === undefined && spec.fidelity !== "digest_only"
            ? ""
            : `sha256:${"a".repeat(64)}`,
        bytesRef:
          spec.text === undefined || spec.fidelity === "digest_only"
            ? ""
            : "evb:v1:k:abc",
        redactions: "",
        toolName:
          spec.kind === "tool_call" ? (spec.label.split(" ")[0] ?? "") : "",
        toolStatus:
          spec.kind === "tool_call" ? (spec.label.split(" ")[1] ?? "") : "",
        toolUseId: "",
        model: "",
        provider: "",
        policyDecision: spec.decision ?? "",
        costUsdMicros:
          spec.costMicros === undefined ? null : Number(spec.costMicros),
        turnSeq: spec.turn,
      }),
    ),
  );
  // The run's own prefix sum, exactly as `get_run_transcript` computes it:
  // an entry's cumulative cost is what the run had spent by then.
  let running: bigint | null = null;
  const entries = specs.map((spec, index) => {
    if (spec.costMicros !== undefined) {
      running = (running ?? 0n) + BigInt(spec.costMicros);
    }
    const fold = folds[index];
    if (fold === undefined)
      throw new Error(`no fold for seq ${String(spec.seq)}`);
    const fidelity = spec.fidelity ?? "full";
    const body = transcriptBody({
      seq: String(spec.seq),
      type: spec.type,
      fidelity,
      text: fidelity === "digest_only" ? null : (spec.text ?? null),
      bytesRef: fidelity === "digest_only" ? null : "evb:v1:k:abc",
    });
    const request = REQUEST_TYPES.has(spec.type);
    const facts: Partial<TranscriptEntry> = {
      kind: fold.kind,
      kinds: [...fold.kinds],
      node: fold.node,
      quiet: fold.quiet,
      outcome: fold.outcome,
      error: countsAsError(fold),
      subject: fold.subject,
      family: fold.family,
      model: spec.kind === "model_call" ? spec.label : null,
    };
    return transcriptEntry({
      ...facts,
      seq: String(spec.seq),
      endSeq: String(spec.seq),
      at: at(-3600 + spec.seq * 2),
      elapsedMs: spec.seq * 2000,
      type: spec.type,
      label: spec.label,
      turn: spec.turn,
      frames: 1,
      request: request ? body : null,
      response: request ? null : body,
      decision:
        spec.decision === undefined
          ? null
          : {
              seq: String(spec.seq),
              decision: spec.decision,
              type: spec.type,
              harness: false,
              at: at(-3600 + spec.seq * 2),
            },
      cost:
        spec.costMicros === undefined
          ? null
          : {
              micros: spec.costMicros,
              currency: "USD",
              basis: "gateway_observed",
            },
      cumulativeCost:
        running === null
          ? null
          : {
              micros: String(running),
              currency: "USD",
              basis: "gateway_observed",
            },
    });
  });
  return {
    zoom: "everything",
    kinds: [],
    entries,
    cursor: null,
    complete: true,
    counts: null,
    figures: transcriptFigures(),
    search: null,
    ...overrides,
  };
}

/**
 * The run's figures as the server counts them over the mockup run's steps
 * (`transcriptFigures`, ADR-182): two model steps, two tool calls in two
 * batches, one of them refused, and the time each part took.
 */
export function transcriptFigures(
  overrides: Partial<TranscriptFigures> = {},
): TranscriptFigures {
  return {
    steps: { model: 2, tool: 2 },
    prompts: 2,
    calls: {
      count: 2,
      failed: 1,
      tools: [
        { name: "create_tag", calls: 1 },
        { name: "list_pull_requests", calls: 1 },
      ],
      families: [
        { family: "tool", calls: 2, share: 1, ms: 2000, failed: 1, tools: 2 },
      ],
      batches: {
        count: 2,
        parallel: 0,
        widest: 1,
        fanOut: 1,
        serialMs: 2000,
        togetherMs: 2000,
        histogram: [{ width: 1, batches: 2 }],
      },
    },
    wall: { modelMs: 2000, toolMs: 2000, waitingMs: 0 },
    ...overrides,
  };
}

/**
 * The run's entries as the server counts them, by default over the one model
 * step `runTranscript` holds: a reply that carried a cost record.
 *
 * `frames` are the counts at `everything` the frame tabs' badges read. They
 * default to the policy and recall counts given here, as for a run where
 * each decision and each recall is a step of its own; a test that needs the
 * two apart passes `frames`.
 */
export function transcriptCounts(
  overrides: {
    kinds?: Partial<TranscriptCounts["kinds"]>;
    entries?: number;
    errors?: number;
    policy?: number;
    frames?: TranscriptCounts["frames"];
  } = {},
): TranscriptCounts {
  const frames = overrides.frames ?? {
    kinds: {
      policy: overrides.kinds?.policy ?? 0,
      recall: overrides.kinds?.recall ?? 0,
    },
    policy: overrides.policy ?? 0,
  };
  return {
    frames,
    kinds: {
      prompt: 0,
      responses: 1,
      thinking: 0,
      tools: 0,
      policy: 0,
      usage: 1,
      recall: 0,
      seal: 0,
      errors: 0,
      ...overrides.kinds,
    },
    entries: overrides.entries ?? 1,
    errors: overrides.errors ?? 0,
    policy: overrides.policy ?? 0,
  };
}

export function runTranscript(
  overrides: Partial<RunTranscript> = {},
): RunTranscript {
  return {
    zoom: "steps",
    kinds: [],
    entries: [transcriptEntry()],
    cursor: null,
    complete: true,
    counts: transcriptCounts(),
    figures: null,
    search: null,
    ...overrides,
  };
}

/**
 * `get_run_turns` for a two-turn run: the first priced, with a cache hit, and
 * the second with nothing priced and no input reported.
 */
export function runTurns(overrides: Partial<RunTurns> = {}): RunTurns {
  const usd = (micros: string) => ({
    micros,
    currency: "USD",
    basis: "gateway_observed" as const,
  });
  return {
    turns: [
      {
        turn: 1,
        seq: "1",
        at: "2026-09-15T08:00:01.000Z",
        frames: 9,
        modelSteps: 2,
        toolSteps: 2,
        cost: usd("18240"),
        cumulativeCost: usd("18240"),
        tokens: { inputUncached: 1834, cacheRead: 12_000 },
      },
      {
        turn: 2,
        seq: "10",
        at: "2026-09-15T08:01:12.000Z",
        frames: 4,
        modelSteps: 1,
        toolSteps: 1,
        cost: null,
        cumulativeCost: usd("18240"),
        tokens: { inputUncached: null, cacheRead: null },
      },
    ],
    complete: true,
    ...overrides,
  };
}

export function runCost(overrides: Partial<RunCost> = {}): RunCost {
  return {
    rollup: {
      cost: { micros: "4131265", currency: "USD", basis: "gateway_observed" },
      tokens: {
        inputUncached: 18_204,
        cacheRead: 91_022,
        cacheWrite5m: 4102,
        cacheWrite1h: 0,
        output: 12_004,
        reasoning: 3011,
      },
      cacheHitRate: 0.83,
      turns: 12,
      steps: 96,
      modelCalls: 54,
      toolCalls: 42,
      retries: 2,
      productiveRatio: 0.71,
      byModel: [
        {
          model: "claude-opus-5",
          provider: "anthropic",
          calls: 54,
          cost: {
            micros: "4131265",
            currency: "USD",
            basis: "gateway_observed",
          },
          tokens: {
            inputUncached: 18_204,
            cacheRead: 91_022,
            cacheWrite5m: 4102,
            cacheWrite1h: 0,
            output: 12_004,
            reasoning: 3011,
          },
          // What the rollup recorded for each class; the six sum to `cost`.
          costByClass: {
            inputUncached: gatewayUsd("1092240"),
            cacheRead: gatewayUsd("136533"),
            cacheWrite5m: gatewayUsd("307650"),
            cacheWrite1h: gatewayUsd("0"),
            output: gatewayUsd("2034842"),
            reasoning: gatewayUsd("560000"),
          },
          cacheSaving: gatewayUsd("1228797"),
          hasUnpriced: false,
        },
      ],
      byTool: [{ name: "create_release", calls: 3 }],
      priceEntryIds: ["prc_01k4qj9e"],
      rolledUpAt: at(-240),
    },
    ...overrides,
  };
}

/** One node of the spine; the default is a file the run wrote. */
export function runOutputNode(
  overrides: Partial<RunOutputNode> = {},
): RunOutputNode {
  return {
    seq: "118",
    kind: "file",
    name: "src/release/cut.ts",
    nameIsLocator: false,
    where: "typescript",
    state: "written",
    note: "2 writes",
    stat: { added: 41, removed: 6 },
    observedAt: at(-300),
    digestBefore: null,
    digestAfter: null,
    ...overrides,
  };
}

/** A spine, tallied from the nodes it is given, so a test cannot state a count the nodes deny. */
export function runOutputs(
  nodes: readonly RunOutputNode[] = [],
  overrides: Partial<Omit<RunOutputs, "nodes" | "tally">> = {},
): RunOutputs {
  const of = (kind: RunOutputNode["kind"]) =>
    nodes.filter((node) => node.kind === kind).length;
  return {
    source: "wrapped",
    nodes: [...nodes],
    tally: {
      artifacts:
        of("file") + of("media") + of("change") + of("commit") + of("pr"),
      reads: of("read"),
      gates: of("gate"),
    },
    complete: true,
    ...overrides,
  };
}

type RunReads = {
  detail: Read<RunDetail>;
  /**
   * `list_agents`' first page, which the header's agent card reads for the
   * agent's 30-day runs and spend. A test that says nothing about it gets a
   * refusal, so the card names the harness alone.
   */
  roster?: Read<AgentPage>;
  /**
   * `get_run_work`, started with the page and awaited by the header's
   * checkout strip and the Changes panel. A test that says nothing about it
   * gets a run whose host enrolled no checkout and opened no pull request.
   */
  work?: Read<RunWork>;
  /**
   * The spine above the tabs, read with the page and not with a tab. A test
   * that says nothing about it gets a run that produced nothing, so a test
   * about the header or a tab is not also a test about the spine. A function
   * answers the read itself, which is how a test hands a read that throws.
   */
  outputs?: Read<RunOutputs> | (() => Promise<Read<RunOutputs>>);
  /**
   * Read with the page: the stat row, the Spend by area panel and the Cost
   * tab's count. A test that says nothing about it gets the default rollup.
   */
  cost?: Read<RunCost>;
  /** Only read when the Governed actions tab has a frame body open; refused when absent. */
  frameBody?: Read<RunFrameBody>;
  /**
   * The transcript reads the page makes: the whole run at `steps`, whose
   * counts and figures the page draws (the frame tabs' counts among them)
   * and whose entries the Transcript tab draws, and the run at `everything`
   * when a tab that lists frames is open. A function answers per zoom level, for a test that needs
   * to tell the reads apart. A test that says nothing about it gets one step.
   */
  transcript?:
    | Read<RunTranscript>
    | ((zoom: TranscriptZoom) => Read<RunTranscript>);
  /** Only read when the Chain and seal tab is open; refused when absent. */
  chain?: Read<RunChain>;
  /**
   * `get_run_turns`, only read when the Cost tab is open. A test that says
   * nothing about it gets the two turns `runTurns` builds.
   */
  turns?: Read<RunTurns>;
  /**
   * Read with the page for the Governed actions count, and drawn on that
   * tab. A test that says nothing about them gets an empty queue.
   */
  approvals?: Read<ApprovalQueue>;
  /** As `approvals`, for the calls already decided (#3153). */
  resolvedApprovals?: Read<ResolvedApprovals>;
  /**
   * get_agent for the agent the run names, read with the page for the
   * header's agent card and harness. A test that says nothing about it gets
   * a refusal, so the header says the harness was not recorded.
   */
  agent?: Read<AgentDetail>;
  /**
   * Only read when a parked call on this run names a mandate, the same rule
   * Fleet follows; refused when absent, which is what a run whose approvals
   * drew on none must not reach.
   */
  mandates?: Read<MandateList>;
  /**
   * The organization's price book. The page must not read it (#4069); a test
   * passes one to prove the figures stay the recorded ones whatever it says.
   */
  priceBook?: Read<PriceBook>;
};

/** The agent read a test left out: refused, so nothing about the agent is invented. */
const AGENT_UNREAD: Read<AgentDetail> = {
  ok: false,
  reason: "denied",
  permission: "agent.read",
};

/** A DataSource answering the Run page's reads; `calls` records their arguments. */
export function runSource(reads: RunReads) {
  const calls: {
    get: unknown[][];
    frameBody: unknown[][];
    cost: unknown[][];
    transcript: unknown[][];
    approvals: unknown[][];
    resolvedApprovals: unknown[][];
    chain: unknown[][];
    turns: unknown[][];
    mandates: unknown[][];
    outputs: unknown[][];
    agent: unknown[][];
    /** The page prices nothing, so any read of the price book is a defect (#4069). */
    priceBook: unknown[][];
  } = {
    get: [],
    frameBody: [],
    cost: [],
    transcript: [],
    approvals: [],
    resolvedApprovals: [],
    chain: [],
    turns: [],
    mandates: [],
    outputs: [],
    agent: [],
    priceBook: [],
  };
  const refuse = () => Promise.reject(new Error("not a Run read"));
  const answer = <T>(
    name: keyof typeof calls,
    read: Read<T> | undefined,
  ): ((...args: unknown[]) => Promise<Read<T>>) => {
    return (...args: unknown[]) => {
      calls[name].push(args);
      return read === undefined
        ? Promise.reject(new Error(`${name} was not expected`))
        : Promise.resolve(read);
    };
  };
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse },
    conversations: { latest: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
      assistantEngine: refuse,
    },
    runs: {
      list: refuse,
      outcomesSettings: () =>
        Promise.resolve(
          readOk({
            customerEnabled: false,
            platformDisabled: false,
            platformDisabledReason: null,
            effectiveEnabled: false,
          }),
        ),
      work: (_ctx, runId) =>
        Promise.resolve(
          reads.work ??
            readOk({
              runId,
              machine: null,
              checkouts: [],
              diffs: [],
              pullRequests: [],
              complete: false,
              warnings: ["checkout_context_not_recorded"],
            }),
        ),
      get: answer("get", reads.detail),
      frameBody: answer("frameBody", reads.frameBody),
      cost: answer("cost", reads.cost ?? readOk(runCost())),
      transcript: (ctx, runId, zoom, q) => {
        calls.transcript.push([
          ctx,
          runId,
          zoom,
          { ...q, kinds: q?.kinds ?? [] },
        ]);
        const asked = reads.transcript ?? readOk(runTranscript());
        return Promise.resolve(
          typeof asked === "function" ? asked(zoom) : asked,
        );
      },
      chain: answer("chain", reads.chain),
      turns: answer("turns", reads.turns ?? readOk(runTurns())),
      outputs: (...args: unknown[]) => {
        calls.outputs.push(args);
        const asked = reads.outputs ?? readOk(runOutputs());
        return typeof asked === "function" ? asked() : Promise.resolve(asked);
      },
    },
    approvals: {
      pending: answer(
        "approvals",
        reads.approvals ?? readOk({ items: [], more: false }),
      ),
      resolved: answer(
        "resolvedApprovals",
        reads.resolvedApprovals ?? readOk({ items: [], more: false }),
      ),
      resolvedSince: refuse,
    },
    agents: {
      list: () =>
        reads.roster === undefined ? refuse() : Promise.resolve(reads.roster),
      get: answer("agent", reads.agent ?? AGENT_UNREAD),
      toolbelt: refuse,
      incidents: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      retention: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: (...args: unknown[]) => {
        calls.priceBook.push(args);
        return reads.priceBook === undefined
          ? refuse()
          : Promise.resolve(reads.priceBook);
      },
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    mandates: { list: answer("mandates", reads.mandates), get: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      hub: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
    },
  };
  return { source, calls };
}

export const ok = readOk;

/** A checkout the host enrolled, on a pull request the run pushed to. */
export function runWork(overrides: Partial<RunWork> = {}): RunWork {
  const repository = {
    host: "github.com",
    owner: "acme",
    name: "platform",
    url: "https://github.com/acme/platform",
    connected: true,
  };
  return {
    runId: "tse_7k2m9q",
    machine: { name: "mac-studio.local" },
    checkouts: [
      {
        ref: "co_1",
        path: "~/src/platform/.worktrees/release-3.2",
        branch: "release/3.2",
        headSha: null,
        remoteDigest: null,
        repository,
        firstSeq: "1",
        lastSeq: "431",
      },
    ],
    diffs: [],
    pullRequests: [
      {
        repository,
        number: 482,
        url: "https://github.com/acme/platform/pull/482",
        title: "Release 3.2",
        state: "open",
        headSha: null,
        headRef: "release/3.2",
        baseRef: "main",
        association: "recorded",
        closingIssues: null,
        checkoutRefs: ["co_1"],
        observedAt: at(-300),
        current: true,
        ci: {
          overall: "passing",
          counts: {
            total: 2,
            passed: 2,
            failed: 0,
            pending: 0,
            skipped: 0,
            neutral: 0,
          },
          runs: [
            {
              name: "test",
              status: "completed",
              conclusion: "success",
              url: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
              app: null,
            },
          ],
          complete: true,
        },
        diff: null,
      },
    ],
    complete: true,
    warnings: [],
    ...overrides,
  };
}

/** `list_agents`' first page holding the run's agent, with its 30-day figures. */
export function runRoster(
  overrides: Partial<AgentPage["agents"][number]> = {},
): AgentPage {
  return {
    agents: [
      {
        id: "agt_releasebot",
        slug: "release-bot",
        name: "Release bot",
        description: null,
        agentKey: "acme.core.release-bot",
        harness: "claude-code",
        operatorId: "usr_marcusbell",
        operatorName: "Marcus Bell",
        principalId: "prn_91",
        credentials: 1,
        hosts: 1,
        host: "mac-studio.local",
        status: "enrolled",
        enforcementTier: "harness",
        runs30d: 212,
        spend30d: {
          micros: "612480000",
          currency: "USD",
          basis: "gateway_observed",
        },
        tokens30d: null,
        mandates: 0,
        incidents: 0,
        tamperIncidents: 0,
        tamperIncidentsRecorded: 0,
        ...overrides,
      },
    ],
    nextCursor: null,
    totals: {
      identities: 1,
      enrolled: 1,
      unenrolled: 0,
      holdingMandate: 0,
      mandateHolders: [],
      tamperIncidents: 0,
      tamper: { recorded: 0, open: 0, newest: null },
    },
  };
}
