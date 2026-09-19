// Typed Run values for the Run component tests (ARCHITECTURE.md §5): the
// detail read, its frames, the cost rollup, a transcript, and a DataSource
// that answers the Run page's reads with what a test hands it. Importable from
// tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type {
  RunCost,
  RunDetail,
  RunFrame,
  RunFrameBody,
  RunTranscript,
  TranscriptEntry,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
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
    operatorId: "usr_marcusbell",
    status: "sealed",
    turns: 12,
    steps: 96,
    frames: 431,
    cost: { micros: "4131265", currency: "USD", basis: "gateway_observed" },
    taskRef: "ENG-4121 cut the 3.2 release",
    name: "Cut the 3.2 release branch",
    summary: {
      text: "Cut release/3.2 from main, bumped eleven package versions, and opened the release pull request.",
      generatedAt: at(-120),
      model: "z-ai/glm-flash-latest",
    },
    replayGrade: "fork",
    startedAt: at(-3600),
    sealedAt: at(-300),
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

export function transcriptEntry(
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    seq: "11",
    endSeq: "14",
    at: at(-3000),
    kind: "model_call",
    type: "model.call_completed",
    label: "claude-opus-5",
    text: "Cutting release/3.2 from main.",
    truncated: false,
    fidelity: "full",
    frames: 4,
    turn: 1,
    cost: { micros: "18240", currency: "USD", basis: "gateway_observed" },
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
  const frame = (
    seq: number,
    type: string,
    kind: TranscriptEntry["kind"],
    label: string,
    turn: number | null,
    over: Partial<TranscriptEntry> = {},
  ): TranscriptEntry =>
    transcriptEntry({
      seq: String(seq),
      endSeq: String(seq),
      at: at(-3600 + seq * 2),
      kind,
      type,
      label,
      turn,
      frames: 1,
      text: null,
      fidelity: "full",
      cost: null,
      ...over,
    });
  const cost = (micros: string) =>
    ({ micros, currency: "USD", basis: "gateway_observed" }) as const;
  return {
    zoom: "everything",
    entries: [
      frame(0, "agent_start", "frame", "agent_start", null),
      frame(1, "context.assembled", "frame", "context.assembled", null),
      frame(2, "turn_start", "frame", "turn_start", 1, {
        text: "Cut the 2026.9.2 release candidate.",
      }),
      frame(3, "model.request", "model_call", "anthropic/claude-fable-5-1", 1),
      frame(
        4,
        "model.response",
        "model_call",
        "anthropic/claude-fable-5-1",
        1,
        {
          text: "I will list the open pull requests first.",
          cost: cost("380000"),
        },
      ),
      frame(5, "tool_requested", "tool_call", "list_pull_requests", 1),
      frame(6, "policy_decision", "frame", "policy allow", 1),
      frame(7, "tool_call", "tool_call", "list_pull_requests ok", 1, {
        text: '{"open":34}',
      }),
      frame(8, "turn_end", "frame", "turn_end", 1, {
        text: "Both failures predate the release scope.",
      }),
      frame(9, "turn_start", "frame", "turn_start", 2),
      frame(10, "llm_call", "model_call", "anthropic/claude-fable-5-1", 2, {
        cost: cost("520000"),
        fidelity: "digest_only",
      }),
      frame(11, "tool_requested", "tool_call", "create_tag", 2),
      frame(12, "policy_decision", "frame", "policy deny", 2),
    ],
    complete: true,
    ...overrides,
  };
}

export function runTranscript(
  overrides: Partial<RunTranscript> = {},
): RunTranscript {
  return {
    zoom: "steps",
    entries: [transcriptEntry()],
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

type RunReads = {
  detail: Read<RunDetail>;
  /** Only read when the Cost tab is open; refused when absent. */
  cost?: Read<RunCost>;
  /** Only read when the Frames tab has a frame body open; refused when absent. */
  frameBody?: Read<RunFrameBody>;
  /** Only read when the Transcript tab is open; refused when absent. */
  transcript?: Read<RunTranscript>;
};

/** A DataSource answering the Run page's reads; `calls` records their arguments. */
export function runSource(reads: RunReads) {
  const calls: {
    get: unknown[][];
    frameBody: unknown[][];
    cost: unknown[][];
    transcript: unknown[][];
    /** The Run page reads no approvals: the store records no run on one. */
    approvals: unknown[][];
  } = {
    get: [],
    frameBody: [],
    cost: [],
    transcript: [],
    approvals: [],
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
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse },
    runs: {
      list: refuse,
      get: answer("get", reads.detail),
      frameBody: answer("frameBody", reads.frameBody),
      cost: answer("cost", reads.cost),
      transcript: answer("transcript", reads.transcript),
    },
    approvals: { pending: answer("approvals", undefined) },
    agents: { list: refuse, get: refuse, toolbelt: refuse, incidents: refuse },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      modelCredential: refuse,
    },
    mandates: { list: refuse },
    audit: { events: refuse, exportEvents: refuse },
    skills: { inventory: refuse },
    steering: { records: refuse, proposals: refuse, contextPr: refuse },
    tools: { versions: refuse, grants: refuse, killSwitches: refuse },
  };
  return { source, calls };
}

export const ok = readOk;
