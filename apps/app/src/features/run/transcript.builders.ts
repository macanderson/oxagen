// A run shaped like the mockup's release run (`TRANSCRIPTS.run_01K5RS7M2E8FJ3QW`
// in the roadmap's fixtures), as `get_run_transcript` answers it at
// `everything`: one entry per frame, the chips each frame answers to, the
// cost records and the contract's running total. The Transcript tab's tests
// read it, and so does the local render harness that compares the tab with
// the mockup. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import type {
  RunTranscript,
  TranscriptBody,
  TranscriptEntry,
  TranscriptKind,
  TranscriptUsage,
} from "@/data/contracts/run";
import { NOW, transcriptBody, transcriptEntry } from "./run.builders";

/** The run's first frame, an hour before the instant every Run test renders at. */
const START = NOW - 3_600_000;

type Block = NonNullable<TranscriptBody["blocks"]>[number];

/** One frame of the run: what the recorder wrote, in the words a test reads. */
export type FrameSpec = {
  seq: number;
  /** Seconds from the run's start. */
  t: number;
  type: string;
  kind: TranscriptEntry["kind"];
  label?: string;
  turn: number | null;
  /** The half the frame carries: what went out, or what came back. */
  request?: string;
  response?: string;
  blocks?: Block[];
  costMicros?: string;
  usage?: TranscriptUsage;
  decision?: string;
  callKey?: string;
  /** Chips beyond the ones the frame's type answers to. */
  kinds?: TranscriptKind[];
  fidelity?: TranscriptBody["fidelity"];
  truncated?: boolean;
  subagent?: TranscriptEntry["subagent"];
};

const MODEL = new Set([
  "model.request",
  "model.response",
  "llm_call",
  "model.engine_call_started",
  "model.engine_call_completed",
]);
const TOOL = new Set([
  "tool_requested",
  "tool_call",
  "tool.engine_call_started",
  "tool.engine_call_completed",
]);
const POLICY = new Set([
  "policy_decision",
  "approval_request",
  "approval_decision",
  "token_issued",
]);
// Mirrors RECALL_TYPES in packages/run-ledger/src/run-frames.ts.
const RECALL = new Set([
  "context.assembled",
  "context.frames_selected",
  "context.instructions_applied",
  "steering.manifest",
]);

/** The chips a frame answers to, as the ledger's `frameKinds` derives them. */
function kindsOf(spec: FrameSpec): TranscriptKind[] {
  const kinds = new Set<TranscriptKind>(spec.kinds ?? []);
  if (MODEL.has(spec.type))
    kinds.add(spec.request === undefined ? "responses" : "prompt");
  if (TOOL.has(spec.type)) kinds.add("tools");
  if (POLICY.has(spec.type)) kinds.add("policy");
  if (RECALL.has(spec.type)) kinds.add("recall");
  if (spec.costMicros !== undefined) kinds.add("usage");
  return [...kinds];
}

/**
 * The entries the specs describe, with each entry's cumulative cost the
 * contract's own prefix sum over the cost records before it.
 */
export function transcriptOf(
  specs: readonly FrameSpec[],
  overrides: Partial<RunTranscript> = {},
): RunTranscript {
  let running = 0;
  let spent = false;
  const entries = specs.map((spec) => {
    if (spec.costMicros !== undefined) {
      running += Number(spec.costMicros);
      spent = true;
    }
    const seq = String(spec.seq);
    const at = new Date(START + spec.t * 1000).toISOString();
    const body = (text: string | undefined, blocks?: Block[]) =>
      text === undefined && blocks === undefined
        ? null
        : transcriptBody({
            seq,
            type: spec.type,
            fidelity: spec.fidelity ?? "full",
            text: text ?? null,
            truncated: spec.truncated ?? false,
            ...(blocks === undefined ? {} : { blocks }),
          });
    const cost = (micros: string) => ({
      micros,
      currency: "USD",
      basis: "gateway_observed" as const,
    });
    return transcriptEntry({
      seq,
      endSeq: seq,
      at,
      elapsedMs: Math.round(spec.t * 1000),
      kind: spec.kind,
      type: spec.type,
      label: spec.label ?? spec.type,
      callKey: spec.callKey ?? null,
      usage: spec.usage ?? null,
      kinds: kindsOf(spec),
      request: body(spec.request),
      response: body(spec.response, spec.blocks),
      decision:
        spec.decision === undefined
          ? null
          : { seq, decision: spec.decision, type: spec.type, at },
      frames: 1,
      turn: spec.turn,
      cost: spec.costMicros === undefined ? null : cost(spec.costMicros),
      cumulativeCost: spent ? cost(String(running)) : null,
      ...(spec.subagent === undefined ? {} : { subagent: spec.subagent }),
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

/**
 * The release run: the operator's prompt, what was recalled, then each model
 * step's thinking, words and cost, and the calls it made. The list call is
 * allowed by a policy decision keyed to it, the lint run fails and is fixed,
 * and the release call is parked on an approval nobody has answered yet.
 */
export function releaseSpecs(): FrameSpec[] {
  return [
    { seq: 0, t: 0, type: "agent_start", kind: "frame", turn: null },
    {
      seq: 1,
      t: 0,
      type: "turn_start",
      kind: "frame",
      turn: 1,
      request: PROMPT,
    },
    {
      seq: 2,
      t: 0.3,
      type: "context.assembled",
      kind: "frame",
      turn: 1,
      response: JSON.stringify({
        tokens: 11204,
        frames: [
          {
            kind: "fact",
            label: "Repository a-intel/platform @ a4c91e2",
            tokens: 1204,
          },
          { kind: "doc", label: "CHANGELOG.md · chunk 3 of 9", tokens: 3880 },
          {
            kind: "symbol",
            label: "releaseNotes() · scripts/release.ts:44",
            tokens: 902,
          },
          {
            kind: "rule",
            label: "ctx.release.notes-format",
            tokens: 2410,
          },
          { kind: "doc", label: "RELEASING.md", tokens: 1908 },
          { kind: "fact", label: "Tag v4.10.3 @ 9d02e11", tokens: 900 },
        ],
      }),
    },
    {
      seq: 3,
      t: 0.4,
      type: "model.request",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      turn: 1,
      request: '{"model":"claude-opus-5","messages":[]}',
      callKey: "msg_1",
    },
    {
      seq: 4,
      t: 7.7,
      type: "model.response",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      turn: 1,
      callKey: "msg_1",
      blocks: [
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
          input: { repo: "a-intel/platform", state: "closed", base: "main" },
          callKey: "toolu_1",
        },
      ],
      costMicros: "412600",
      usage: usage(3368, 12000, 412),
    },
    {
      seq: 5,
      t: 7.8,
      type: "tool_requested",
      kind: "tool_call",
      label: "mcp__github__list_pull_requests",
      turn: 1,
      callKey: "toolu_1",
      request: JSON.stringify({
        repo: "a-intel/platform",
        state: "closed",
        base: "main",
      }),
    },
    {
      seq: 6,
      t: 7.8,
      type: "policy_decision",
      kind: "policy",
      label: "allow mcp__github__list_pull_requests",
      turn: 1,
      callKey: "toolu_1",
      decision: "allow",
    },
    {
      seq: 7,
      t: 8.9,
      type: "tool_call",
      kind: "tool_call",
      label: "mcp__github__list_pull_requests ok",
      turn: 1,
      callKey: "toolu_1",
      response: JSON.stringify({
        input: { repo: "a-intel/platform", state: "closed", base: "main" },
        output:
          "31 pull requests\n#482 Release notes format\n#481 Worker pools scale on queue depth\n#478 Release lint checks heading order\n#476 Mobile push tokens\n#472 Worker restart keeps the lease\n#470 Move release config",
      }),
    },
    {
      seq: 8,
      t: 16.7,
      type: "model.response",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      turn: 1,
      blocks: [
        {
          kind: "text",
          text: "31 merged in range. Reading CHANGELOG.md for the heading order and tone.",
        },
      ],
      costMicros: "551800",
      usage: usage(902, 14190, 688),
    },
    {
      seq: 9,
      t: 16.8,
      type: "tool_call",
      kind: "tool_call",
      label: "Read ok",
      turn: 1,
      callKey: "toolu_2",
      response: JSON.stringify({
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
    },
    {
      seq: 10,
      t: 49.3,
      type: "model.response",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      turn: 1,
      blocks: [
        {
          kind: "text",
          text: "Writing the draft for the 27 platform pull requests.",
        },
      ],
      costMicros: "390400",
      usage: usage(264, 15020, 501),
    },
    {
      seq: 11,
      t: 49.4,
      type: "tool_call",
      kind: "tool_call",
      label: "Write ok",
      turn: 1,
      callKey: "toolu_3",
      response: JSON.stringify({
        input: {
          file_path: "/Users/mbell/src/platform/release/4.11.0-notes.md",
          content: NOTES,
        },
        output: "File created",
      }),
    },
    {
      seq: 12,
      t: 61.2,
      type: "tool_call",
      kind: "tool_call",
      label: "Bash error",
      turn: 1,
      callKey: "toolu_4",
      kinds: ["errors"],
      response: JSON.stringify({
        input: { command: "pnpm release:lint release/4.11.0-notes.md" },
        output: {
          stdout:
            "> a-intel-platform@4.10.3 release:lint\n> node scripts/release-lint.mjs release/4.11.0-notes.md\n\nerror: heading order. Breaking must precede Fixes (line 12)\n  rule: ctx.release.notes-format",
          stderr: "",
        },
      }),
    },
    {
      seq: 13,
      t: 70,
      type: "model.response",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      turn: 1,
      blocks: [
        {
          kind: "thinking",
          text: "The linter encodes ctx.release.notes-format and it wants Breaking above Fixes. Swap the two sections and lint again.",
        },
        {
          kind: "text",
          text: "The lint rule wants Breaking before Fixes. Swapping the sections.",
        },
      ],
      costMicros: "622000",
      usage: usage(1188, 15284, 734),
    },
    {
      seq: 14,
      t: 70.1,
      type: "tool_call",
      kind: "tool_call",
      label: "Edit ok",
      turn: 1,
      callKey: "toolu_5",
      response: JSON.stringify({
        input: {
          file_path: "/Users/mbell/src/platform/release/4.11.0-notes.md",
          old_string:
            "## Fixes\n- Worker restart no longer drops the lease (#472)",
          new_string:
            "## Breaking\n- `release.config` moves to `.oxagen/release.toml` (#470)",
        },
        output: "The file was updated",
      }),
    },
    {
      seq: 15,
      t: 96.9,
      type: "model.response",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      turn: 1,
      blocks: [
        {
          kind: "text",
          text: "Creating the v4.11.0 draft release from release/4.11.0-notes. It stays unpublished until someone approves.",
        },
      ],
      costMicros: "861500",
      usage: usage(1490, 17600, 912),
    },
    {
      seq: 16,
      t: 97.1,
      type: "tool_requested",
      kind: "tool_call",
      label: "mcp__github__create_release",
      turn: 1,
      callKey: "toolu_6",
      request: JSON.stringify({
        repo: "a-intel/platform",
        tag_name: "v4.11.0",
        draft: true,
      }),
    },
    {
      seq: 17,
      t: 97.2,
      type: "approval_request",
      kind: "policy",
      label: "approval_request mcp__github__create_release",
      turn: 1,
      callKey: "toolu_6",
    },
  ];
}

/** The release run as the Transcript tab reads it. */
export function releaseTranscript(
  overrides: Partial<RunTranscript> = {},
): RunTranscript {
  return transcriptOf(releaseSpecs(), overrides);
}
