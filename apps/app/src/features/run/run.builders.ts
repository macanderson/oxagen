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
    cost: { micros: "18240", currency: "USD", basis: "gateway_observed" },
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
    shell: { context: refuse, preferences: refuse },
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
