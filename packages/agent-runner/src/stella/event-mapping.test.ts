/**
 * Stella `AgentEvent` frames → `CodingEvent`s.
 *
 * The field names asserted here are read off stella's own
 * `crates/stella-protocol/src/event/kind.rs`: `TextDelta { delta }` (with
 * `text` as a serde alias), `ToolStart { call }`, and
 * `ToolResult { call_id, output, duration_ms }`. A rename upstream turns these
 * red, which is the point — the alternative is a mapper that silently stops
 * mapping and an event log that silently goes quiet.
 */
import { describe, expect, test } from "vitest";
import { createEventMapper } from "./event-mapping";

describe("createEventMapper", () => {
  test("maps a text delta, under either spelling", () => {
    const mapper = createEventMapper();
    expect(mapper.map({ type: "text_delta", delta: "hel" })).toEqual({
      type: "text",
      delta: "hel",
    });
    // `text` is the serde alias upstream; accept it rather than depending on
    // which spelling a given build emits.
    expect(mapper.map({ type: "text_delta", text: "lo" })).toEqual({
      type: "text",
      delta: "lo",
    });
  });

  test("maps reasoning separately from text", () => {
    expect(
      createEventMapper().map({ type: "reasoning", delta: "hmm" }),
    ).toEqual({ type: "reasoning", delta: "hmm" });
  });

  test("a tool_start becomes a tool-call and is counted", () => {
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: "tool_start",
        call: { call_id: "c1", name: "read_file", input: { path: "a.ts" } },
      }),
    ).toEqual({
      type: "tool-call",
      name: "read_file",
      input: { path: "a.ts" },
    });
    expect(mapper.toolCallCount).toBe(1);
  });

  test("a tool_result recovers name and input from the start it follows", () => {
    const mapper = createEventMapper();
    mapper.map({
      type: "tool_start",
      call: { call_id: "c1", name: "grep", input: { q: "needle" } },
    });
    expect(
      mapper.map({
        type: "tool_result",
        call_id: "c1",
        output: { ok: { content: "found it" } },
        duration_ms: 42,
      }),
    ).toEqual({
      type: "tool-result",
      name: "grep",
      input: '{"q":"needle"}',
      result: "found it",
      durationMs: 42,
      ok: true,
    });
  });

  test("the error arm reports ok:false and carries the message", () => {
    const mapper = createEventMapper();
    mapper.map({
      type: "tool_start",
      call: { call_id: "c1", name: "bash", input: { cmd: "false" } },
    });
    expect(
      mapper.map({
        type: "tool_result",
        call_id: "c1",
        output: { error: { message: "exit status 1" } },
        duration_ms: 7,
      }),
    ).toMatchObject({ ok: false, result: "exit status 1" });
  });

  test("an unreadable output is reported as a failure, never as success", () => {
    const mapper = createEventMapper();
    mapper.map({
      type: "tool_start",
      call: { call_id: "c1", name: "x", input: {} },
    });
    expect(
      mapper.map({ type: "tool_result", call_id: "c1", output: "surprise" }),
    ).toMatchObject({ ok: false });
  });

  test("a result whose start was missed is still emitted, with an empty name", () => {
    // A dropped row is an invisible gap; an empty name is a visible one.
    expect(
      createEventMapper().map({
        type: "tool_result",
        call_id: "orphan",
        output: { ok: { content: "x" } },
        duration_ms: 1,
      }),
    ).toMatchObject({ type: "tool-result", name: "", durationMs: 1 });
  });

  test("caps input and result exactly as engine.ts does", () => {
    const mapper = createEventMapper();
    mapper.map({
      type: "tool_start",
      call: { call_id: "c1", name: "t", input: "x".repeat(5000) },
    });
    const event = mapper.map({
      type: "tool_result",
      call_id: "c1",
      output: { ok: { content: "y".repeat(5000) } },
      duration_ms: 0,
    }) as { input: string; result: string };
    expect(event.input).toHaveLength(1001); // 1000 + the ellipsis
    expect(event.result).toHaveLength(2001);
    expect(event.result.endsWith("…")).toBe(true);
  });

  test("an event with no CodingEvent spelling is skipped, not guessed at", () => {
    const mapper = createEventMapper();
    // The raw frame still reaches `onStreamPart`; this map is the lossy
    // projection, not the record.
    expect(mapper.map({ type: "step_usage", step: 1 })).toBeUndefined();
    expect(mapper.map({ type: "turn_complete", model: "m" })).toBeUndefined();
    expect(mapper.map({ type: "text_delta" })).toBeUndefined();
    expect(
      mapper.map({ type: "tool_start", call: { call_id: "c" } }),
    ).toBeUndefined();
  });

  test("does not synthesise host-owned events", () => {
    // `file-edit`, `command` and `final-diff` are emitted by the host's own
    // tool wrappers; synthesising them here would double-count.
    const mapper = createEventMapper();
    for (const type of ["file_edit", "command", "final_diff", "diff"]) {
      expect(mapper.map({ type })).toBeUndefined();
    }
  });
});
