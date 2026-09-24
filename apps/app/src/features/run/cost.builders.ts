// Fixtures for the Cost tab: a whole-run transcript at `everything` scripted
// turn by turn, and a rollup whose per-model rows sum to its totals, so the
// derivation (`runMetrics`) sees a run whose figures reconcile the way a real
// one does. Each turn opens on `turn_start` and closes on `turn_end`; a model
// step is a `model.request`/`model.response` pair carrying its cost and usage
// on the response; a batch is the tool calls one model reply asked for, all
// requested at once and each closed by its own `tool_call` under a shared
// `callKey`, the way a harness records calls it runs together.
import type { Cost } from "@/data/contracts/money";
import type {
  RunCost,
  RunTranscript,
  TokenCounts,
  TranscriptEntry,
  TranscriptKind,
} from "@/data/contracts/run";
import type { PriceBook } from "@/data/contracts/spend";
import { TOKEN_CLASSES, type TokenClass } from "./metrics";
import { NOW, runCost, transcriptBody, transcriptEntry } from "./run.builders";

type ToolCallSpec = {
  name: string;
  /** How long the call ran. */
  ms: number;
  /** The call's close records an error status (`Bash error`). */
  fails?: boolean;
  /** A person held the call this long before it ran (an `approval_request`). */
  approvalMs?: number;
};

type StepSpec =
  | {
      kind: "model";
      /** The step's recorded cost in USD micros; null when none was recorded. */
      micros: string | null;
      ms: number;
      cacheRead: number;
      inputUncached: number;
    }
  | { kind: "tools"; calls: ToolCallSpec[] };

export type TurnSpec = {
  /** The turn opens on words from the operator. */
  prompt: boolean;
  steps: StepSpec[];
};

type Event = {
  t: number;
  type: string;
  kind: TranscriptEntry["kind"];
  label: string;
  turn: number;
  kinds: TranscriptKind[];
  callKey: string | null;
  micros: string | null;
  usage: TranscriptEntry["usage"];
};

const usd = (micros: string): Cost => ({
  micros,
  currency: "USD",
  basis: "gateway_observed",
});

/** The gap between two frames the script does not time. */
const TICK = 200;

/**
 * The run as `get_run_transcript` returns it at `everything`, from a script of
 * turns. The run starts `startSecondsAgo` before `NOW`; every entry's
 * `cumulativeCost` is the run's own prefix sum.
 */
export function costTranscript(
  turns: readonly TurnSpec[],
  { startSecondsAgo = 780 }: { startSecondsAgo?: number } = {},
): RunTranscript {
  const events: Event[] = [];
  let t = 0;
  let key = 0;
  const push = (event: Omit<Event, "t">, at: number) =>
    events.push({ ...event, t: at });
  turns.forEach((spec, index) => {
    const turn = index + 1;
    const frame = {
      turn,
      callKey: null,
      micros: null,
      usage: null,
    };
    push(
      {
        ...frame,
        type: "turn_start",
        kind: "frame",
        label: "turn_start",
        kinds: spec.prompt ? ["prompt"] : [],
      },
      t,
    );
    t += TICK;
    for (const step of spec.steps) {
      if (step.kind === "model") {
        push(
          {
            ...frame,
            type: "model.request",
            kind: "model_call",
            label: "anthropic/claude-opus-5",
            kinds: ["responses"],
          },
          t,
        );
        t += step.ms;
        push(
          {
            ...frame,
            type: "model.response",
            kind: "model_call",
            label: "anthropic/claude-opus-5",
            kinds: ["responses", "usage"],
            micros: step.micros,
            usage: {
              inputUncached: step.inputUncached,
              cacheRead: step.cacheRead,
              cacheWrite: 0,
              output: 0,
              reasoning: 0,
            },
          },
          t,
        );
        t += TICK;
        continue;
      }
      const start = t;
      let end = start;
      for (const call of step.calls) {
        key += 1;
        const callKey = `call_${String(key)}`;
        push(
          {
            ...frame,
            callKey,
            type: "tool_requested",
            kind: "tool_call",
            label: call.name,
            kinds: ["tools"],
          },
          start,
        );
        const held = call.approvalMs ?? 0;
        if (held > 0)
          push(
            {
              ...frame,
              callKey,
              type: "approval_request",
              kind: "policy",
              label: `approve ${call.name}`,
              kinds: ["policy"],
            },
            start + 1,
          );
        const closed = start + held + call.ms;
        push(
          {
            ...frame,
            callKey,
            type: "tool_call",
            kind: "tool_call",
            label: `${call.name} ${call.fails === true ? "error" : "ok"}`,
            kinds: call.fails === true ? ["tools", "errors"] : ["tools"],
          },
          closed,
        );
        end = Math.max(end, closed);
      }
      t = end + TICK;
    }
    push(
      {
        ...frame,
        type: "turn_end",
        kind: "frame",
        label: "turn_end",
        kinds: [],
      },
      t,
    );
    t += TICK;
  });
  // Frames are recorded in the order they happened; a stable sort keeps a
  // batch's requests ahead of its closes when two share an instant.
  const ordered = events
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.t - b.event.t || a.order - b.order)
    .map(({ event }) => event);
  // The run's own prefix sum, exactly as `get_run_transcript` computes it.
  let running: bigint | null = null;
  const entries = ordered.map((event, index) => {
    if (event.micros !== null) running = (running ?? 0n) + BigInt(event.micros);
    const seq = String(index);
    const at = new Date(NOW - startSecondsAgo * 1000 + event.t).toISOString();
    return transcriptEntry({
      seq,
      endSeq: seq,
      at,
      elapsedMs: event.t,
      kind: event.kind,
      type: event.type,
      label: event.label,
      callKey: event.callKey,
      usage: event.usage,
      kinds: event.kinds,
      request: null,
      response: transcriptBody({ seq, type: event.type }),
      decision: null,
      frames: 1,
      turn: event.turn,
      cost: event.micros === null ? null : usd(event.micros),
      cumulativeCost: running === null ? null : usd(String(running)),
    });
  });
  return {
    zoom: "everything",
    kinds: [],
    entries,
    cursor: null,
    complete: true,
  };
}

/**
 * A rollup whose one per-model row carries the run's whole token count, so
 * the classes priced per model from the book cover exactly the tokens the
 * total row counts.
 */
export function costRollup({
  micros,
  tokens,
  cacheHitRate,
  productiveRatio = 0.71,
  retries = 2,
  modelCalls,
}: {
  micros: string;
  tokens: TokenCounts;
  cacheHitRate: number | null;
  productiveRatio?: number | null;
  retries?: number | null;
  modelCalls: number;
}): RunCost {
  const base = runCost().rollup;
  if (base === null) throw new Error("runCost() carries a rollup");
  return {
    rollup: {
      ...base,
      cost: usd(micros),
      tokens,
      cacheHitRate,
      productiveRatio,
      retries,
      modelCalls,
      byModel: [
        {
          model: "claude-opus-5",
          provider: "anthropic",
          calls: modelCalls,
          cost: usd(micros),
          tokens,
        },
      ],
    },
  };
}

/** The organization's book with one row per class for `claude-opus-5`, rates in USD micros per million. */
export function opusBook(
  rates: Partial<Record<TokenClass, string>> = {},
): PriceBook {
  const all: Record<TokenClass, string> = {
    input_uncached: "5000000",
    cache_read: "500000",
    cache_write_5m: "6250000",
    cache_write_1h: "10000000",
    output: "25000000",
    reasoning: "25000000",
    ...rates,
  };
  return {
    at: "2026-09-15T00:00:00.000Z",
    entries: TOKEN_CLASSES.map((tokenClass) => ({
      provider: "anthropic",
      model: "claude-opus-5",
      modelAliases: [],
      region: null,
      tokenClass,
      unit: "token" as const,
      ratePerMillion: { micros: all[tokenClass], currency: "USD" },
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      source: "list" as const,
      negotiated: false,
    })),
  };
}

/**
 * The mockup's release run (`run_01K5RS7M2E8FJ3QW`) as a script: seven turns
 * at $0.41, $0.55, $0.39, $0.71, $0.88, $0.64 and $0.55, two prompts, tool
 * calls in batches of one to three, one call that failed, and a release call
 * a person held ten minutes before it ran.
 */
export function releaseRunTurns(): TurnSpec[] {
  const model = (
    micros: string,
    ms: number,
    cacheRead: number,
    inputUncached: number,
  ): StepSpec => ({ kind: "model", micros, ms, cacheRead, inputUncached });
  const tools = (...calls: ToolCallSpec[]): StepSpec => ({
    kind: "tools",
    calls,
  });
  return [
    {
      prompt: true,
      steps: [
        model("210000", 9_000, 60_000, 9_000),
        tools({ name: "Read", ms: 900 }, { name: "Grep", ms: 1_400 }),
        model("200000", 8_000, 70_000, 10_000),
        tools({ name: "Bash", ms: 2_100 }),
      ],
    },
    {
      prompt: true,
      steps: [
        model("300000", 10_000, 80_000, 11_000),
        tools(
          { name: "Read", ms: 700 },
          { name: "Read", ms: 1_100 },
          { name: "Grep", ms: 600 },
        ),
        model("250000", 7_000, 90_000, 12_000),
      ],
    },
    {
      prompt: false,
      steps: [
        model("390000", 8_000, 91_000, 9_000),
        tools({ name: "Edit", ms: 400 }),
      ],
    },
    {
      prompt: false,
      steps: [
        model("400000", 11_000, 82_000, 18_000),
        tools({ name: "Bash", ms: 3_000, fails: true }),
        model("310000", 9_000, 70_000, 15_000),
        tools({ name: "Read", ms: 800 }, { name: "Edit", ms: 500 }),
      ],
    },
    {
      prompt: false,
      steps: [
        model("880000", 12_000, 74_000, 26_000),
        tools({ name: "mcp__github__list_pull_requests", ms: 1_800 }),
      ],
    },
    {
      prompt: false,
      steps: [
        model("640000", 10_000, 79_000, 21_000),
        tools({ name: "Grep", ms: 500 }, { name: "Read", ms: 600 }),
      ],
    },
    {
      prompt: false,
      steps: [
        model("550000", 9_000, 83_000, 17_000),
        tools({
          name: "mcp__github__create_release",
          ms: 1_200,
          approvalMs: 600_000,
        }),
      ],
    },
  ];
}

/** The release run's rollup: its tokens by class and its recorded $4.13. */
export function releaseRunCost(): RunCost {
  return costRollup({
    micros: "4130000",
    tokens: {
      inputUncached: 124_486,
      cacheRead: 607_784,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 24_229,
      reasoning: 12_482,
    },
    cacheHitRate: 0.83,
    modelCalls: 10,
  });
}
