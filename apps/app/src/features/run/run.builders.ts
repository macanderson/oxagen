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
  TranscriptBody,
  TranscriptEntry,
  TranscriptZoom,
} from "@/data/contracts/run";
import type {
  ApprovalQueue,
  ResolvedApprovalItem,
} from "@/data/contracts/approvals";
import type { MandateList } from "@/data/contracts/mandates";
import type { RunRow } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import type { AgentDetail } from "@/data/contracts/agents";
import { type Read, readOk } from "@/data/read";

/** The instant every Run test renders at. */
export const NOW = Date.parse("2026-09-15T09:00:00.000Z");

const at = (secondsFromNow: number): string =>
  new Date(NOW + secondsFromNow * 1000).toISOString();

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

export function transcriptEntry(
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
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
    ...overrides,
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
    { seq: 9, type: "turn_start", kind: "frame", label: "turn_start", turn: 2 },
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
  // The run's own prefix sum, exactly as `get_run_transcript` computes it:
  // an entry's cumulative cost is what the run had spent by then.
  let running: bigint | null = null;
  const entries = specs.map((spec) => {
    if (spec.costMicros !== undefined) {
      running = (running ?? 0n) + BigInt(spec.costMicros);
    }
    const fidelity = spec.fidelity ?? "full";
    const body = transcriptBody({
      seq: String(spec.seq),
      type: spec.type,
      fidelity,
      text: fidelity === "digest_only" ? null : (spec.text ?? null),
      bytesRef: fidelity === "digest_only" ? null : "evb:v1:k:abc",
    });
    const request = REQUEST_TYPES.has(spec.type);
    return transcriptEntry({
      seq: String(spec.seq),
      endSeq: String(spec.seq),
      at: at(-3600 + spec.seq * 2),
      elapsedMs: spec.seq * 2000,
      kind: spec.kind,
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
    ...overrides,
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
   * The whole-run transcript is read with the page (the Prompts figure, the
   * Policy and Context tabs and their counts); the Transcript tab reads it
   * again only through pressed chips, and the Cost tab reads it per zoom
   * level for the waterfall. A function answers per zoom level, which is how
   * a Cost-tab test hands one transcript for `turns` and another for
   * `steps`. A test that says nothing about it gets one step.
   */
  transcript?:
    | Read<RunTranscript>
    | ((zoom: TranscriptZoom) => Read<RunTranscript>);
  /** Only read when the Chain and seal tab is open; refused when absent. */
  chain?: Read<RunChain>;
  /**
   * Read with the page for the Governed actions count, and drawn on that
   * tab. A test that says nothing about them gets an empty queue.
   */
  approvals?: Read<ApprovalQueue>;
  /** As `approvals`, for the calls already decided (#3153). */
  resolvedApprovals?: Read<ResolvedApprovalItem[]>;
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
    mandates: unknown[][];
    outputs: unknown[][];
    agent: unknown[][];
  } = {
    get: [],
    frameBody: [],
    cost: [],
    transcript: [],
    approvals: [],
    resolvedApprovals: [],
    chain: [],
    mandates: [],
    outputs: [],
    agent: [],
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
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse, preferences: refuse },
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
        calls.transcript.push([ctx, runId, zoom, { kinds: q?.kinds ?? [] }]);
        const asked = reads.transcript ?? readOk(runTranscript());
        return Promise.resolve(
          typeof asked === "function" ? asked(zoom) : asked,
        );
      },
      chain: answer("chain", reads.chain),
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
        reads.resolvedApprovals ?? readOk([]),
      ),
    },
    agents: {
      list: refuse,
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
      priceBook: refuse,
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
      sso: refuse,
    },
    mandates: { list: answer("mandates", reads.mandates), get: refuse },
    audit: { events: refuse, exportEvents: refuse },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      hub: refuse,
      deliveries: refuse,
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
