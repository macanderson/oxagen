// A run shaped like the mockup's release run (`TRANSCRIPTS.run_01K5RS7M2E8FJ3QW`
// in the roadmap's fixtures), as `get_run_transcript` answers it at `steps`:
// one entry per step the server folded (ADR-182), with what the fold states
// about each, the cost records and the contract's running total. Each fixture
// is written in the contract's own shape and passed through the port's mapper
// (`toRunTranscript`), so the Transcript tab's tests read what the page reads.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type {
  RunTranscriptGetOutput,
  TranscriptEntry as ContractEntry,
  TranscriptEntryBody,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  RunTranscript,
  type ToolFamily,
  type TranscriptKind,
  type TranscriptMatch,
  type TranscriptNode,
  type TranscriptOutcome,
  type TranscriptRecall,
  type TranscriptUsage,
} from "@/data/contracts/run";
import { toRunTranscript } from "@/data/live/mappers/run";
import { NOW } from "./run.builders";

/**
 * A frame a context frame listed, as the server reads it (`recallOf`): a
 * context listing records no outcome, so every frame reached the model.
 */
function listedFrame(
  kind: string,
  label: string,
  tokens: number,
): TranscriptRecall["items"][number] {
  return {
    kind,
    label,
    tokens,
    outcome: "included",
    reason: null,
    supersededBy: null,
    force: null,
  };
}

/** The run's first frame, an hour before the instant every Run test renders at. */
const START = NOW - 3_600_000;

type Block = NonNullable<ContractBody["assembly"]>["blocks"][number];
type ContractBody = TranscriptEntryBody;

/** One block of an assembled reply, in the words a test reads. */
export type BlockSpec =
  | { kind: "text" | "thinking"; text: string }
  | {
      kind: "tool_use";
      name: string;
      input: unknown;
      callKey: string | null;
      /** The tool step that recorded the call; null for a call none recorded. */
      stepKey?: string | null;
      result?: { ok: boolean; summary: string } | null;
      family?: ToolFamily;
      /** The name as the harness knows it, as the server reads it; absent means the answer did not say. */
      tool?: string;
    }
  | { kind: "tool_result"; forId: string; ok: boolean; summary: string };

/** One half of a step: the frame that carried it, and what it said. */
export type HalfSpec = {
  seq: number;
  type: string;
  text?: string | null;
  /** The reply as the recorder assembled it; the half then carries no text. */
  blocks?: BlockSpec[];
  fidelity?: "full" | "digest_only";
  truncated?: boolean;
  /** The subagent chain the frame was recorded on. */
  sessionUuid?: string;
};

/** One step of the run, as the server's fold states it. */
export type StepSpec = {
  /** The frame the step opens on. */
  seq: number;
  endSeq?: number;
  /** Seconds from the run's start to the opening frame. */
  t: number;
  type: string;
  kind: ContractEntry["kind"];
  node: TranscriptNode | null;
  label?: string;
  turn: number | null;
  callId?: string;
  request?: HalfSpec;
  response?: HalfSpec;
  costMicros?: string;
  usage?: TranscriptUsage;
  effort?: string;
  /** Every decision folded into the step, in order. */
  gates?: {
    seq: number;
    decision: string;
    type: string;
    source?: string;
    /** Whether the server read the source as the harness checking itself. */
    harness?: boolean;
    sessionUuid?: string;
  }[];
  kinds?: TranscriptKind[];
  outcome?: TranscriptOutcome | null;
  subject?: string;
  /** The subject as the harness knows it, as the server reads it; absent means the answer did not say. */
  tool?: string;
  family?: ToolFamily;
  model?: string;
  durationMs?: number;
  approvalId?: string;
  target?: string;
  echoOf?: string;
  quiet?: boolean;
  recall?: TranscriptRecall;
  parentKey?: string;
  subagent?: { sessionUuid: string; type: string | null; spawnCallId?: string };
  frames?: number;
  matches?: TranscriptMatch[];
};

const block = (spec: BlockSpec, index: number): Block => {
  const base = {
    id: `b${String(index)}`,
    chars: 0,
    tokens: 0,
    partial: false,
    cost: null,
  };
  switch (spec.kind) {
    case "text":
    case "thinking":
      return spec.kind === "text"
        ? { ...base, kind: "text", text: spec.text, truncated: false }
        : {
            ...base,
            kind: "thinking",
            text: spec.text,
            truncated: false,
            seconds: null,
          };
    case "tool_use":
      return {
        ...base,
        kind: "tool_use",
        name: spec.name,
        input: spec.input,
        inputRaw: false,
        inputFolded: false,
        callKey: spec.callKey,
        verdict: null,
        stepKey: spec.stepKey ?? null,
        result: spec.result ?? null,
        ...(spec.family === undefined ? {} : { family: spec.family }),
        ...(spec.tool === undefined ? {} : { tool: spec.tool }),
      };
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        forId: spec.forId,
        ok: spec.ok,
        summary: spec.summary,
        bytes: null,
        ms: null,
      };
  }
};

function half(spec: HalfSpec | undefined): ContractBody | null {
  if (spec === undefined) return null;
  const fidelity = spec.fidelity ?? "full";
  return {
    seq: String(spec.seq),
    ...(spec.sessionUuid === undefined
      ? {}
      : { sessionUuid: spec.sessionUuid }),
    type: spec.type,
    digest: `sha256:${"a".repeat(64)}`,
    bytesRef: fidelity === "digest_only" ? null : "evb:v1:k:abc",
    redactions: [],
    fidelity,
    text: spec.blocks === undefined ? (spec.text ?? null) : null,
    truncated: spec.truncated ?? false,
    assembly:
      spec.blocks === undefined
        ? null
        : {
            blocks: spec.blocks.map(block),
            precis: "",
            stopReason: null,
            ttftMs: null,
            durationMs: null,
            tokensPerSecond: null,
            usage: {
              inputTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              outputTokens: null,
            },
            partial: false,
            wire: { events: 0, bytes: 0 },
          },
  };
}

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});

/**
 * The steps as `get_run_transcript` answers them, through the port's mapper.
 * Each entry's cumulative cost is the prefix sum of the cost records before
 * it, as the contract states it.
 */
export function stepsOf(
  specs: readonly StepSpec[],
  overrides: Partial<RunTranscriptGetOutput> = {},
): RunTranscript {
  let running = 0;
  let spent = false;
  const entries = specs.map((spec): ContractEntry => {
    if (spec.costMicros !== undefined) {
      running += Number(spec.costMicros);
      spent = true;
    }
    const seq = String(spec.seq);
    const at = new Date(START + spec.t * 1000).toISOString();
    const gates = (spec.gates ?? []).map((gate) => ({
      seq: String(gate.seq),
      ...(gate.sessionUuid === undefined
        ? {}
        : { sessionUuid: gate.sessionUuid }),
      decision: gate.decision,
      type: gate.type,
      source: gate.source ?? null,
      harness: gate.harness ?? false,
      at,
    }));
    return {
      seq,
      endSeq: String(spec.endSeq ?? spec.seq),
      ...(spec.subagent === undefined
        ? {}
        : {
            subagent: {
              sessionUuid: spec.subagent.sessionUuid,
              id: null,
              type: spec.subagent.type,
              spawnCallId: spec.subagent.spawnCallId ?? null,
              parentSessionUuid: null,
            },
          }),
      at,
      elapsedMs: Math.round(spec.t * 1000),
      kind: spec.kind,
      type: spec.type,
      label: spec.label ?? spec.type,
      callId: spec.callId ?? null,
      target: spec.target ?? null,
      effort: spec.effort ?? null,
      usage: spec.usage ?? null,
      kinds: spec.kinds ?? [],
      request: half(spec.request),
      response: half(spec.response),
      decision: gates[gates.length - 1] ?? null,
      frames:
        spec.frames ??
        (spec.endSeq === undefined ? 1 : spec.endSeq - spec.seq + 1),
      turn: spec.turn,
      cost: spec.costMicros === undefined ? null : usd(spec.costMicros),
      cumulativeCost: spent ? usd(String(running)) : null,
      key:
        spec.subagent === undefined
          ? seq
          : `${spec.subagent.sessionUuid}:${seq}`,
      parentKey: spec.parentKey ?? null,
      node: spec.node,
      quiet: spec.quiet ?? false,
      outcome: spec.outcome ?? null,
      approvalId: spec.approvalId ?? null,
      gates,
      subject: spec.subject ?? null,
      ...(spec.tool === undefined ? {} : { tool: spec.tool }),
      family: spec.family ?? null,
      model: spec.model ?? null,
      durationMs: spec.durationMs ?? null,
      echoOf: spec.echoOf ?? null,
      recall: spec.recall ?? null,
      ...(spec.matches === undefined ? {} : { matches: spec.matches }),
    };
  });
  return RunTranscript.parse(
    toRunTranscript({
      zoom: "steps",
      kinds: [],
      entries,
      cursor: null,
      complete: true,
      ...overrides,
    }),
  );
}

const PROMPT =
  "Cut the 4.11.0 release notes for a-intel/platform.\n\nDraft from every pull request merged since the v4.10.3 tag, group them under Features, Fixes and Breaking, and write the draft to release/4.11.0-notes.md on a release branch. Then create the GitHub release v4.11.0 as a draft so nothing publishes until it is approved. Follow ctx.release.notes-format. Do not touch main.";

const NOTES =
  "# 4.11.0 · 2026-09-11\n\n27 pull requests merged since 4.10.3.\n\n## Features\n- Worker pools scale on queue depth (#481)\n- Release lint checks heading order (#478)\n\n## Fixes\n- Worker restart no longer drops the lease (#472)\n\n## Breaking\n- `release.config` moves to `.oxagen/release.toml` (#470)";

function usage(input: number, cache: number, output: number): TranscriptUsage {
  return {
    inputUncached: input,
    cacheRead: cache,
    cacheWrite: null,
    output,
    reasoning: null,
  };
}

/** A model step that answered, as the fold states one: its reply and its cost. */
function modelStep(
  seq: number,
  t: number,
  blocks: BlockSpec[],
  costMicros: string,
  used: TranscriptUsage,
): StepSpec {
  return {
    seq,
    t,
    type: "model.response",
    kind: "model_call",
    node: "model",
    label: "anthropic/claude-opus-5",
    turn: 1,
    response: { seq, type: "model.response", blocks },
    costMicros,
    usage: used,
    kinds: ["responses", "usage"],
    outcome: "ok",
    model: "anthropic/claude-opus-5",
  };
}

/** A tool call a wrapped harness sealed as one receipt, holding its input and output. */
function receipt(
  seq: number,
  t: number,
  subject: string,
  family: ToolFamily,
  body: unknown,
  extra: Partial<StepSpec> = {},
): StepSpec {
  return {
    seq,
    t,
    type: "tool_call",
    kind: "tool_call",
    node: "tool",
    label: `${subject} ok`,
    turn: 1,
    callId: `toolu_${String(seq)}`,
    response: { seq, type: "tool_call", text: JSON.stringify(body) },
    kinds: ["tools"],
    outcome: "ok",
    subject,
    family,
    ...extra,
  };
}

/**
 * The release run: the operator's prompt, what was recalled, then each model
 * step's thinking, words and cost, and the calls it made. The list call is
 * allowed by a policy decision keyed to it, the lint run fails and is fixed,
 * and the release call is parked on an approval nobody has answered yet.
 */
export function releaseSteps(): StepSpec[] {
  const listInput = { repo: "a-intel/platform", state: "closed", base: "main" };
  // The first reply: what the model thought, what it said, and the list call
  // it made, which the tool step at seq 5 recorded.
  const firstReply: BlockSpec[] = [
    {
      kind: "thinking",
      text: "The task wants three groups and a house format. Reading the changelog once tells me the heading order.",
    },
    {
      kind: "text",
      text: "I'll list the pull requests merged since v4.10.3 first, then read CHANGELOG.md once for the format.",
    },
    {
      kind: "tool_use",
      name: "mcp__github__list_pull_requests",
      input: listInput,
      callKey: "toolu_1",
      stepKey: "5",
      family: "mcp",
    },
  ];
  return [
    {
      seq: 0,
      t: 0,
      type: "agent_start",
      kind: "frame",
      node: "control",
      turn: null,
      quiet: true,
    },
    {
      seq: 1,
      t: 0,
      type: "turn_start",
      kind: "frame",
      node: "prompt",
      turn: 1,
      request: { seq: 1, type: "turn_start", text: PROMPT },
      kinds: ["prompt"],
    },
    {
      seq: 2,
      t: 0.3,
      type: "context.assembled",
      kind: "frame",
      node: "recall",
      turn: 1,
      kinds: ["recall"],
      recall: {
        unit: "frames",
        count: 6,
        tokens: 11204,
        cut: null,
        items: [
          listedFrame("fact", "Repository a-intel/platform @ a4c91e2", 1204),
          listedFrame("doc", "CHANGELOG.md · chunk 3 of 9", 3880),
          listedFrame("symbol", "releaseNotes() · scripts/release.ts:44", 902),
          listedFrame("rule", "ctx.release.notes-format", 2410),
          listedFrame("doc", "RELEASING.md", 1908),
          listedFrame("fact", "Tag v4.10.3 @ 9d02e11", 900),
        ],
        bundleVersion: null,
        body: "listed",
      },
    },
    {
      ...modelStep(3, 0.4, firstReply, "412600", {
        ...usage(3368, 12000, 412),
        reasoning: 64,
      }),
      type: "model.request",
      endSeq: 4,
      callId: "msg_1",
      request: {
        seq: 3,
        type: "model.request",
        text: '{"model":"claude-opus-5","messages":[]}',
      },
      response: { seq: 4, type: "model.response", blocks: firstReply },
      durationMs: 7300,
    },
    {
      seq: 5,
      endSeq: 7,
      t: 7.8,
      type: "tool_requested",
      kind: "tool_call",
      node: "tool",
      label: "mcp__github__list_pull_requests",
      turn: 1,
      callId: "toolu_1",
      request: {
        seq: 5,
        type: "tool_requested",
        text: JSON.stringify(listInput),
      },
      response: {
        seq: 7,
        type: "tool_call",
        text: JSON.stringify({
          input: listInput,
          output:
            "31 pull requests\n#482 Release notes format\n#481 Worker pools scale on queue depth\n#478 Release lint checks heading order\n#476 Mobile push tokens\n#472 Worker restart keeps the lease\n#470 Move release config",
        }),
      },
      gates: [{ seq: 6, decision: "allow", type: "policy_decision" }],
      kinds: ["tools", "policy"],
      outcome: "ok",
      subject: "mcp__github__list_pull_requests",
      family: "mcp",
      durationMs: 1100,
    },
    modelStep(
      8,
      16.7,
      [
        {
          kind: "text",
          text: "31 merged in range. Reading CHANGELOG.md for the heading order and tone.",
        },
      ],
      "551800",
      usage(902, 14190, 688),
    ),
    receipt(9, 16.8, "Read", "read", {
      input: { file_path: "/Users/mbell/src/platform/CHANGELOG.md" },
      output: {
        type: "text",
        file: {
          filePath: "/Users/mbell/src/platform/CHANGELOG.md",
          content:
            "# Changelog\n\n## 4.10.3 · 2026-08-27\n\n### Fixes\n- Worker restart no longer drops the lease\n\n### Breaking\n- none",
        },
      },
    }),
    modelStep(
      10,
      49.3,
      [
        {
          kind: "text",
          text: "Writing the draft for the 27 platform pull requests.",
        },
      ],
      "390400",
      usage(264, 15020, 501),
    ),
    receipt(11, 49.4, "Write", "create", {
      input: {
        file_path: "/Users/mbell/src/platform/release/4.11.0-notes.md",
        content: NOTES,
      },
      output: "File created",
    }),
    receipt(
      12,
      61.2,
      "Bash",
      "shell",
      {
        input: { command: "pnpm release:lint release/4.11.0-notes.md" },
        output: {
          stdout:
            "> a-intel-platform@4.10.3 release:lint\n> node scripts/release-lint.mjs release/4.11.0-notes.md\n\nerror: heading order. Breaking must precede Fixes (line 12)\n  rule: ctx.release.notes-format",
          stderr: "",
        },
      },
      { label: "Bash error", kinds: ["tools", "errors"], outcome: "failed" },
    ),
    modelStep(
      13,
      70,
      [
        {
          kind: "thinking",
          text: "The linter encodes ctx.release.notes-format and it wants Breaking above Fixes. Swap the two sections and lint again.",
        },
        {
          kind: "text",
          text: "The lint rule wants Breaking before Fixes. Swapping the sections.",
        },
      ],
      "622000",
      { ...usage(1188, 15284, 734), reasoning: 48 },
    ),
    receipt(14, 70.1, "Edit", "edit", {
      input: {
        file_path: "/Users/mbell/src/platform/release/4.11.0-notes.md",
        old_string:
          "## Fixes\n- Worker restart no longer drops the lease (#472)",
        new_string:
          "## Breaking\n- `release.config` moves to `.oxagen/release.toml` (#470)",
      },
      output: "The file was updated",
    }),
    modelStep(
      15,
      96.9,
      [
        {
          kind: "text",
          text: "Creating the v4.11.0 draft release from release/4.11.0-notes. It stays unpublished until someone approves.",
        },
      ],
      "861500",
      usage(1490, 17600, 912),
    ),
    {
      seq: 16,
      endSeq: 17,
      t: 97.1,
      type: "tool_requested",
      kind: "tool_call",
      node: "tool",
      label: "mcp__github__create_release",
      turn: 1,
      callId: "toolu_6",
      request: {
        seq: 16,
        type: "tool_requested",
        text: JSON.stringify({
          repo: "a-intel/platform",
          tag_name: "v4.11.0",
          draft: true,
        }),
      },
      gates: [
        { seq: 17, decision: "approval_request", type: "approval_request" },
      ],
      kinds: ["tools", "policy"],
      outcome: "parked",
      subject: "mcp__github__create_release",
      family: "mcp",
    },
  ];
}

/**
 * What the server counts over the release run at `steps`: each chip's
 * entries (the two model steps that reported reasoning tokens answer
 * thinking), the entries with something to show, the failed call, and the
 * two decisions a rule made.
 */
export function releaseCounts(): NonNullable<RunTranscriptGetOutput["counts"]> {
  return {
    kinds: {
      prompt: 1,
      responses: 5,
      thinking: 2,
      tools: 6,
      policy: 2,
      usage: 5,
      recall: 1,
      seal: 0,
      errors: 1,
    },
    entries: 13,
    errors: 1,
    policy: 2,
  };
}

/** The release run as the Transcript tab reads it. */
export function releaseTranscript(
  overrides: Partial<RunTranscriptGetOutput> = {},
): RunTranscript {
  return stepsOf(releaseSteps(), { counts: releaseCounts(), ...overrides });
}
