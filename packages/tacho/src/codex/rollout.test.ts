/**
 * The Codex rollout reader against rollouts Codex 0.158 wrote on a real
 * host, with every id, path, name and line of text replaced
 * (`fixtures/codex/transcript/`): one frame per response that a usage
 * record closes, the response id as the join key, nothing for history a
 * forked thread copied, and a state that survives a JSON round trip.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptDraft } from "../claude-code/transcript";
import { digestJcs, type JsonValue } from "../digest";
import { TACHO_MAX_BODY_BYTES } from "../wire";
import { type CodexRolloutState, normalizeRolloutLine } from "./rollout";

const AT = "2026-09-30T12:00:00.000Z";
const FIXTURES = join(__dirname, "..", "..", "fixtures", "codex", "transcript");

/** The members of a rollout line these tests read. */
interface RolloutRecord {
  timestamp: string;
  ordinal: number;
  type: string;
  payload: {
    type?: string;
    role?: string;
    call_id?: string;
    name?: string;
    input?: unknown;
    response_id?: string;
    turn_id?: string;
    subagent_history_start_ordinal?: number;
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
    };
  };
}

function lines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function records(name: string): RolloutRecord[] {
  return lines(name).map((line) => JSON.parse(line) as RolloutRecord);
}

function feed(
  input: readonly string[],
  start?: CodexRolloutState,
): { drafts: TranscriptDraft[]; state: CodexRolloutState } {
  let state = start;
  const drafts: TranscriptDraft[] = [];
  for (const line of input) {
    const out = normalizeRolloutLine(line, state, AT);
    drafts.push(...out.normalized.drafts);
    state = out.state;
  }
  return { drafts, state: state ?? {} };
}

function text(draft: TranscriptDraft | undefined): string | undefined {
  const bytes = draft?.content?.bytes;
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/** A tool request as the reader writes it into the body. */
function toolUse(record: RolloutRecord): string {
  const item = record.payload;
  return JSON.stringify({
    tool_use: { id: item.call_id, name: item.name, input: item.input },
  });
}

function usageRecords(all: readonly RolloutRecord[]): RolloutRecord[] {
  return all.filter((record) => record.type === "token_usage_record");
}

function assistantText(record: RolloutRecord): string {
  return (record.payload.content ?? [])
    .filter((block) => block.type === "output_text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function byOrdinal(
  all: readonly RolloutRecord[],
  ordinal: number,
): RolloutRecord {
  const found = all.find((record) => record.ordinal === ordinal);
  if (found === undefined) throw new Error(`no line at ordinal ${ordinal}`);
  return found;
}

/** One line of a given type, in the rollout shape. */
function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-09-30T10:00:00.000Z",
    type,
    payload,
  });
}

const META = line("session_meta", {
  id: "019a2b3c-4d5e-7f60-8a9b-000000000001",
  model_provider: "openai",
});
const TURN = line("turn_context", {
  turn_id: "turn-1",
  model: "gpt-6-astra",
});
function message(textValue: string, turnId = "turn-1"): string {
  return line("response_item", {
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "output_text", text: textValue }],
    phase: "final_answer",
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}
function usage(responseId: string, turnId = "turn-1"): string {
  return line("token_usage_record", {
    thread_id: "019a2b3c-4d5e-7f60-8a9b-000000000001",
    turn_id: turnId,
    response_id: responseId,
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_input_tokens: 0,
      output_tokens: 40,
      reasoning_output_tokens: 12,
      total_tokens: 1040,
    },
  });
}

describe("normalizeRolloutLine", () => {
  it("drafts one llm_call for a response its usage record closes", () => {
    const all = records("final-answer.jsonl");
    const { drafts } = feed(lines("final-answer.jsonl"));
    const [record] = usageRecords(all);
    const answer = all.find(
      (r) => r.type === "response_item" && r.payload.role === "assistant",
    );
    if (record?.payload.usage === undefined || answer === undefined)
      throw new Error("the fixture has no closed response");
    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    const reported = record.payload.usage;
    expect(draft?.kind).toBe("llm_call");
    expect(draft?.body).toEqual({
      provider: "openai",
      model: "gpt-6-astra",
      message_id: record.payload.response_id,
      // The proxy's figure: the cached part is not counted twice.
      input_tokens: reported.input_tokens - reported.cached_input_tokens,
      output_tokens: reported.output_tokens,
      cache_read_tokens: reported.cached_input_tokens,
      cache_creation_tokens: reported.cache_write_input_tokens,
      thinking_tokens: reported.reasoning_output_tokens,
    });
    expect(text(draft)).toBe(assistantText(answer));
    expect(draft?.turn).toEqual({ turn_id: record.payload.turn_id });
    expect(draft?.ts).toBe(new Date(record.timestamp).toISOString());
    expect(draft?.raw_source_digest).toBe(
      digestJcs(record as unknown as JsonValue),
    );
    expect(draft?.attrs).toEqual({
      "transcript.content_block_types": JSON.stringify(["message"]),
    });
  });

  it("puts a response's text and tool requests on its own frame, for every response", () => {
    const all = records("tool-calls.jsonl");
    const { drafts, state } = feed(lines("tool-calls.jsonl"));
    const closes = usageRecords(all);
    expect(drafts).toHaveLength(3);
    expect(drafts.map((d) => d.body["message_id"])).toEqual(
      closes.map((record) => record.payload.response_id),
    );
    // Text, then the tool it asked for, as Claude Code's body has them.
    expect(text(drafts[0])).toBe(
      `${assistantText(byOrdinal(all, 11))}\n${toolUse(byOrdinal(all, 12))}`,
    );
    expect(drafts[0]?.attrs).toEqual({
      "transcript.content_block_types": JSON.stringify([
        "message",
        "custom_tool_call",
      ]),
      "transcript.tool_use_ids": JSON.stringify([
        byOrdinal(all, 12).payload.call_id,
      ]),
    });
    // A response that only called a tool still has a body.
    expect(text(drafts[1])).toBe(toolUse(byOrdinal(all, 19)));
    // Reasoning is listed and not shipped, as Claude Code's thinking is not.
    expect(
      JSON.parse(drafts[2]?.attrs["transcript.content_block_types"] ?? "[]"),
    ).toEqual(["reasoning", "message", "custom_tool_call"]);
    expect(text(drafts[2])).toBe(
      `${assistantText(byOrdinal(all, 29))}\n${toolUse(byOrdinal(all, 30))}`,
    );
    expect(state.held).toBeUndefined();
    expect(state.unknown).toBeUndefined();
  });

  it("drops the text of a response cut short, rather than put it on the next one", () => {
    const all = records("preempted.jsonl");
    const { drafts, state } = feed(lines("preempted.jsonl"));
    expect(drafts).toHaveLength(2);
    // The message at 1517 belongs to a response an inter-agent message cut
    // short: a `token_count` came before any usage record of its own.
    expect(text(drafts[1])).toBe(toolUse(byOrdinal(all, 1522)));
    expect(text(drafts[1])).not.toContain(
      assistantText(byOrdinal(all, 1517)),
    );
    expect(drafts[1]?.body["message_id"]).toBe(
      byOrdinal(all, 1523).payload.response_id,
    );
    expect(state.orphaned).toBe(1);
  });

  it("reads none of the history a forked subagent copied from its parent", () => {
    const all = records("subagent-fork.jsonl");
    const { drafts, state } = feed(lines("subagent-fork.jsonl"));
    expect(state.historyStart).toBe(
      all[0]?.payload.subagent_history_start_ordinal,
    );
    expect(drafts.map((d) => d.body["message_id"])).toEqual(
      usageRecords(all)
        .filter((record) => record.ordinal >= (state.historyStart ?? 0))
        .map((record) => record.payload.response_id),
    );
    expect(drafts.every((d) => d.body["provider"] === "openai")).toBe(true);
  });

  it("seals nothing for a copied usage record", () => {
    // The whole file is history this thread copied, a usage record included.
    const all = records("guardian-history.jsonl");
    expect(usageRecords(all)).toHaveLength(1);
    expect(feed(lines("guardian-history.jsonl")).drafts).toEqual([]);
  });

  it("carries its state through JSON, as the tail cursor persists it", () => {
    const input = lines("final-answer.jsonl");
    const at = input.findIndex(
      (l) => (JSON.parse(l) as RolloutRecord).type === "token_usage_record",
    );
    const before = feed(input.slice(0, at));
    expect(before.drafts).toEqual([]);
    expect(before.state.held?.parts).toHaveLength(1);
    const restored = JSON.parse(
      JSON.stringify(before.state),
    ) as CodexRolloutState;
    const after = feed(input.slice(at), restored);
    expect(after.drafts).toEqual(feed(input).drafts);
  });

  it("leaves the state it was given as it was", () => {
    const first = feed([META, TURN, message("hello")]).state;
    const copy = JSON.parse(JSON.stringify(first)) as CodexRolloutState;
    normalizeRolloutLine(usage("resp_1"), first, AT);
    normalizeRolloutLine(message("more"), first, AT);
    expect(first).toEqual(copy);
  });

  it("skips and counts a record type it does not know", () => {
    const { drafts, state } = feed([
      META,
      line("hologram", { anything: true }),
      line("hologram", {}),
      line("response_item", { type: "telepathy_call" }),
      "not json",
      JSON.stringify({ payload: {} }),
      // Known types it has nothing to read from count as known.
      line("world_state", {}),
      line("event_msg", { type: "agent_reasoning" }),
      line("response_item", { type: "function_call_output", output: "x" }),
    ]);
    expect(drafts).toEqual([]);
    expect(state.unknown).toEqual({
      hologram: 2,
      "response_item:telepathy_call": 1,
      "(not json)": 1,
      "(untyped)": 1,
    });
  });

  it("names at most sixteen unknown types, and never a prototype member", () => {
    const strange = Array.from({ length: 18 }, (_, i) => line(`kind_${i}`, {}));
    const { state } = feed([line("constructor", {}), ...strange]);
    expect(state.unknown?.["(constructor)"]).toBe(1);
    expect(Object.keys(state.unknown ?? {})).toHaveLength(17);
    expect(state.unknown?.["(more)"]).toBe(3);
  });

  it("parses a function call's arguments into the tool request", () => {
    const { drafts } = feed([
      META,
      TURN,
      line("response_item", {
        type: "function_call",
        name: "spawn_agent",
        arguments: '{"task":"review"}',
        call_id: "call_1",
      }),
      line("response_item", {
        type: "function_call",
        name: "shell",
        arguments: "not json",
        call_id: "call_2",
      }),
      usage("resp_1"),
    ]);
    expect(text(drafts[0])).toBe(
      [
        JSON.stringify({
          tool_use: { id: "call_1", name: "spawn_agent", input: { task: "review" } },
        }),
        JSON.stringify({
          tool_use: { id: "call_2", name: "shell", input: "not json" },
        }),
      ].join("\n"),
    );
    expect(drafts[0]?.attrs["transcript.tool_use_ids"]).toBe(
      JSON.stringify(["call_1", "call_2"]),
    );
  });

  it("drops text a turn boundary leaves without a usage record", () => {
    const { drafts, state } = feed([
      META,
      TURN,
      message("never closed"),
      line("event_msg", { type: "task_complete", turn_id: "turn-1" }),
      usage("resp_2"),
    ]);
    expect(state.orphaned).toBe(1);
    expect(drafts).toHaveLength(1);
    // The record closes a response that wrote nothing this reader saw, such
    // as a compaction call, so its body is empty rather than missing.
    expect(text(drafts[0])).toBe("");
    expect(drafts[0]?.body["message_id"]).toBe("resp_2");
  });

  it("does not put one turn's text on another turn's response", () => {
    const { drafts, state } = feed([
      META,
      TURN,
      message("from turn one", "turn-1"),
      usage("resp_3", "turn-2"),
    ]);
    expect(drafts[0]?.content).toBeUndefined();
    expect(drafts[0]?.turn).toEqual({ turn_id: "turn-2" });
    expect(state.orphaned).toBe(1);
  });

  it("gives a compaction call an empty body", () => {
    // Codex writes the compaction call's usage record, then the `compacted`
    // line that holds its summary, encrypted.
    const { drafts } = feed([
      META,
      TURN,
      line("event_msg", { type: "token_count" }),
      usage("resp_7"),
      line("compacted", { message: "", replacement_history: [] }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(text(drafts[0])).toBe("");
    expect(drafts[0]?.attrs).toEqual({});
  });

  it("gives a response with only reasoning an empty body", () => {
    const { drafts } = feed([
      META,
      TURN,
      line("response_item", { type: "reasoning", summary: [] }),
      usage("resp_4"),
    ]);
    expect(text(drafts[0])).toBe("");
  });

  it("says why a response too long to ship has no body", () => {
    const { drafts, state } = feed([
      META,
      TURN,
      message("x".repeat(TACHO_MAX_BODY_BYTES)),
      message("one more"),
    ]);
    expect(state.held?.tooLarge).toBe(true);
    expect(state.held?.parts).toEqual([]);
    const closed = feed([usage("resp_5")], state);
    expect(drafts).toEqual([]);
    expect(closed.drafts[0]?.content).toBeUndefined();
    expect(closed.drafts[0]?.attrs["body_omitted"]).toBe("too_large");
    expect(closed.drafts[0]?.body["output_tokens"]).toBe(40);
  });

  it("takes the model from the latest turn context", () => {
    const { drafts } = feed([
      META,
      TURN,
      line("turn_context", { turn_id: "turn-2", model: "gpt-6-mini" }),
      usage("resp_6", "turn-2"),
    ]);
    expect(drafts[0]?.body["model"]).toBe("gpt-6-mini");
  });
});
