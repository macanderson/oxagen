/**
 * intercept-form-fill.test.ts
 *
 * Unit tests for the interceptFormFillEvents transparent async-generator
 * interceptor. Covers:
 *
 *   (a) onStart fires on tool-call-start for page_form_fill
 *   (b) onStart does NOT fire for other capabilities
 *   (c) onEnd fires on tool-call-end when status=completed with valid output
 *   (d) onEnd does NOT fire when status=failed
 *   (e) onEnd does NOT fire for unknown toolCallId (no matching start)
 *   (f) onEnd does NOT fire when output.fields is missing
 *   (g) All events are yielded unchanged (pass-through)
 *   (h) Reason field included when present; omitted when absent
 *   (i) Null callbacks are safe (no-op, no throw)
 *   (j) Multiple sequential fill tool calls work independently
 */

import { describe, it, expect, vi } from "vitest";
import { interceptFormFillEvents } from "./intercept-form-fill";
import type { StreamEvent } from "./stream-event-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* makeSource(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

async function collectAll(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const TOOL_ID = "tc-fill-1";
const MSG_ID = "msg-1";

const toolCallStart: StreamEvent = {
  type: "tool-call-start",
  toolCallId: TOOL_ID,
  messageId: MSG_ID,
  capability: "page_form_fill",
  inputPreview: { instruction: "Fill in project name" },
  riskLevel: "low",
};

const toolCallEndCompleted: StreamEvent = {
  type: "tool-call-end",
  toolCallId: TOOL_ID,
  status: "completed",
  durationMs: 120,
  output: {
    fields: [
      {
        name: "name",
        current: "old",
        proposed: "My Project",
        changed: true,
        reason: "Instruction says so",
      },
      { name: "description", current: "", proposed: "", changed: false },
    ],
  },
};

const toolCallEndFailed: StreamEvent = {
  type: "tool-call-end",
  toolCallId: TOOL_ID,
  status: "failed",
  durationMs: 50,
  errorReason: "handler panic",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("interceptFormFillEvents", () => {
  // (a)
  it("fires onStart when page_form_fill tool-call-start arrives", async () => {
    const onStart = vi.fn();
    const gen = interceptFormFillEvents(
      makeSource([toolCallStart]),
      onStart,
      null,
    );
    await collectAll(gen);
    expect(onStart).toHaveBeenCalledOnce();
  });

  // (b)
  it("does NOT fire onStart for other capabilities", async () => {
    const onStart = vi.fn();
    const otherStart: StreamEvent = {
      type: "tool-call-start",
      toolCallId: "tc-other",
      messageId: MSG_ID,
      capability: "execute_code",
      inputPreview: {},
      riskLevel: "low",
    };
    const gen = interceptFormFillEvents(
      makeSource([otherStart]),
      onStart,
      null,
    );
    await collectAll(gen);
    expect(onStart).not.toHaveBeenCalled();
  });

  // (c)
  it("fires onEnd with FormFillResult on successful tool-call-end", async () => {
    const onEnd = vi.fn();
    const gen = interceptFormFillEvents(
      makeSource([toolCallStart, toolCallEndCompleted]),
      null,
      onEnd,
    );
    await collectAll(gen);
    expect(onEnd).toHaveBeenCalledOnce();
    const result = onEnd.mock.calls[0]![0];
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toEqual({
      name: "name",
      current: "old",
      proposed: "My Project",
      changed: true,
      reason: "Instruction says so",
    });
    expect(result.fields[1]).toEqual({
      name: "description",
      current: "",
      proposed: "",
      changed: false,
    });
  });

  // (d)
  it("does NOT fire onEnd when status is failed", async () => {
    const onEnd = vi.fn();
    const gen = interceptFormFillEvents(
      makeSource([toolCallStart, toolCallEndFailed]),
      null,
      onEnd,
    );
    await collectAll(gen);
    expect(onEnd).not.toHaveBeenCalled();
  });

  // (e)
  it("does NOT fire onEnd for a tool-call-end with unknown toolCallId", async () => {
    const onEnd = vi.fn();
    const unknownEnd: StreamEvent = {
      type: "tool-call-end",
      toolCallId: "tc-unknown",
      status: "completed",
      durationMs: 10,
      output: {
        fields: [{ name: "x", current: null, proposed: "y", changed: true }],
      },
    };
    const gen = interceptFormFillEvents(makeSource([unknownEnd]), null, onEnd);
    await collectAll(gen);
    expect(onEnd).not.toHaveBeenCalled();
  });

  // (f)
  it("does NOT fire onEnd when output.fields is missing", async () => {
    const onEnd = vi.fn();
    const badEnd: StreamEvent = {
      type: "tool-call-end",
      toolCallId: TOOL_ID,
      status: "completed",
      durationMs: 10,
      output: { noFields: true },
    };
    const gen = interceptFormFillEvents(
      makeSource([toolCallStart, badEnd]),
      null,
      onEnd,
    );
    await collectAll(gen);
    expect(onEnd).not.toHaveBeenCalled();
  });

  // (g)
  it("yields all events unchanged (pass-through)", async () => {
    const textEvent: StreamEvent = {
      type: "text",
      messageId: MSG_ID,
      text: "hello",
    };
    const events = [textEvent, toolCallStart, toolCallEndCompleted];
    const gen = interceptFormFillEvents(makeSource(events), null, null);
    const yielded = await collectAll(gen);
    expect(yielded).toHaveLength(3);
    expect(yielded[0]).toStrictEqual(textEvent);
    expect(yielded[1]).toStrictEqual(toolCallStart);
    expect(yielded[2]).toStrictEqual(toolCallEndCompleted);
  });

  // (h)
  it("omits reason field when not present in output", async () => {
    const onEnd = vi.fn();
    const endWithoutReason: StreamEvent = {
      type: "tool-call-end",
      toolCallId: TOOL_ID,
      status: "completed",
      durationMs: 10,
      output: {
        fields: [{ name: "x", current: null, proposed: "new", changed: true }],
      },
    };
    const gen = interceptFormFillEvents(
      makeSource([toolCallStart, endWithoutReason]),
      null,
      onEnd,
    );
    await collectAll(gen);
    const result = onEnd.mock.calls[0]![0];
    expect(result.fields[0]).not.toHaveProperty("reason");
    expect(result.fields[0]).toEqual({
      name: "x",
      current: null,
      proposed: "new",
      changed: true,
    });
  });

  // (i)
  it("handles null callbacks without throwing", async () => {
    const gen = interceptFormFillEvents(
      makeSource([toolCallStart, toolCallEndCompleted]),
      null,
      null,
    );
    await expect(collectAll(gen)).resolves.toHaveLength(2);
  });

  // (j)
  it("handles multiple sequential fill tool calls independently", async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const TOOL_ID_2 = "tc-fill-2";

    const start2: StreamEvent = {
      type: "tool-call-start",
      toolCallId: TOOL_ID_2,
      messageId: MSG_ID,
      capability: "page_form_fill",
      inputPreview: { instruction: "second fill" },
      riskLevel: "low",
    };
    const end2: StreamEvent = {
      type: "tool-call-end",
      toolCallId: TOOL_ID_2,
      status: "completed",
      durationMs: 80,
      output: {
        fields: [{ name: "y", current: "a", proposed: "b", changed: true }],
      },
    };

    const events = [toolCallStart, toolCallEndCompleted, start2, end2];
    const gen = interceptFormFillEvents(makeSource(events), onStart, onEnd);
    const yielded = await collectAll(gen);

    expect(yielded).toHaveLength(4);
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(2);

    // Second call result
    const secondResult = onEnd.mock.calls[1]![0];
    expect(secondResult.fields[0]!.name).toBe("y");
  });
});
