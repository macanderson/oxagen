/**
 * The ledger's verdicts: first sighting, a duplicate from another source,
 * a repeat from the same source, the tuple fallback and its limits, the
 * capacity, and the state a restart continues from.
 */
import { describe, expect, it } from "vitest";
import {
  LLM_CALL_LEDGER_CAPACITY,
  LlmCallLedger,
  llmCallKeys,
  withoutUsage,
} from "./llm-call-dedupe";

const call = (over: Record<string, unknown> = {}) => ({
  model: "claude-haiku-4-5-20251001",
  request_id: "req_1",
  message_id: "msg_1",
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_creation_tokens: 100,
  ...over,
});

describe("llmCallKeys", () => {
  it("keys by request id, then message id, then the token tuple", () => {
    expect(llmCallKeys(call())).toEqual({
      ids: ["request:req_1", "message:msg_1"],
      tuple: "tuple:claude-haiku-4-5-20251001|10|5|0|100",
    });
    expect(llmCallKeys({ model: "m" })).toEqual({ ids: [], tuple: undefined });
    expect(llmCallKeys({ request_id: "", output_tokens: 1 })).toEqual({
      ids: [],
      tuple: "tuple:||1||",
    });
  });
});

describe("withoutUsage", () => {
  it("removes every counted member and keeps the rest", () => {
    expect(
      withoutUsage(call({ thinking_tokens: 3, stop_reason: "end" })),
    ).toEqual({
      model: "claude-haiku-4-5-20251001",
      request_id: "req_1",
      message_id: "msg_1",
      stop_reason: "end",
    });
  });
});

describe("LlmCallLedger", () => {
  it("registers nothing until a judged sighting commits", () => {
    const ledger = new LlmCallLedger();
    const refused = ledger.judge(call(), "otel_log");
    expect(refused.verdict).toEqual({ kind: "first" });
    // The row was refused, so the sighting never commits: the next source
    // is the first sighting, not a duplicate of a row the chain lacks.
    expect(ledger.state()).toEqual({ keys: [] });
    const landed = ledger.judge(call(), "transcript");
    expect(landed.verdict).toEqual({ kind: "first" });
    landed.commit();
    expect(ledger.note(call(), "otel_log")).toEqual({
      kind: "duplicate",
      of: "transcript",
    });
  });

  it("names the first source on a duplicate and drops a repeat", () => {
    const ledger = new LlmCallLedger();
    expect(ledger.note(call(), "transcript")).toEqual({ kind: "first" });
    expect(ledger.note(call(), "otel_log")).toEqual({
      kind: "duplicate",
      of: "transcript",
    });
    // The third source is a duplicate of the first, not the second.
    expect(ledger.note(call(), "collector")).toEqual({
      kind: "duplicate",
      of: "transcript",
    });
    expect(ledger.note(call(), "otel_log")).toEqual({ kind: "repeat" });
    expect(ledger.note(call(), "transcript")).toEqual({ kind: "repeat" });
    // Another call is another first sighting.
    expect(
      ledger.note(
        call({ request_id: "req_2", message_id: "msg_2" }),
        "transcript",
      ),
    ).toEqual({ kind: "first" });
  });

  it("joins two id-less sightings by a shared tuple, but never an id-less sighting to an identified call or back", () => {
    const ledger = new LlmCallLedger();
    expect(ledger.note(call(), "transcript")).toEqual({ kind: "first" });
    // OTel from a harness that reports no request id, sharing its token
    // tuple with the already-identified call above. Two distinct calls can
    // share a tuple trivially (two 0-token calls, a title prompt asked
    // twice), so this must be its own call, not a duplicate whose usage
    // then goes uncounted.
    const idless = call({ request_id: undefined, message_id: undefined });
    expect(ledger.note(idless, "otel_log")).toEqual({ kind: "first" });
    // Symmetrically, an identified sighting that only matches an id-less
    // entry's tuple is its own call too, not a join across the id boundary.
    expect(
      ledger.note(call({ request_id: "req_2", message_id: "msg_2" }), "hook"),
    ).toEqual({ kind: "first" });
    // Two id-less sightings from different sources, sharing a tuple, are
    // the one case the tuple join exists for: neither can be told apart any
    // other way.
    const fresh = new LlmCallLedger();
    expect(fresh.note(idless, "otel_log")).toEqual({ kind: "first" });
    expect(fresh.note(idless, "collector")).toEqual({
      kind: "duplicate",
      of: "otel_log",
    });
  });

  it("forgets the oldest calls past its capacity", () => {
    const ledger = new LlmCallLedger();
    for (let i = 0; i < LLM_CALL_LEDGER_CAPACITY + 10; i += 1) {
      ledger.note({ request_id: `req_${i}` }, "transcript");
    }
    expect(ledger.note({ request_id: "req_0" }, "otel_log")).toEqual({
      kind: "first",
    });
    expect(
      ledger.note(
        { request_id: `req_${LLM_CALL_LEDGER_CAPACITY + 9}` },
        "otel_log",
      ),
    ).toEqual({ kind: "duplicate", of: "transcript" });
  });

  it("continues from its state after a restart", () => {
    const ledger = new LlmCallLedger();
    ledger.note(call(), "transcript");
    ledger.note(call(), "otel_log");
    const restored = new LlmCallLedger(ledger.state());
    expect(restored.note(call(), "otel_log")).toEqual({ kind: "repeat" });
    expect(restored.note(call(), "collector")).toEqual({
      kind: "duplicate",
      of: "transcript",
    });
    expect(new LlmCallLedger(undefined).note(call(), "otel_log")).toEqual({
      kind: "first",
    });
  });

  it("keeps its own entry for a key it absorbs from another ledger", () => {
    const root = new LlmCallLedger();
    root.note(call(), "otel_log");
    const child = new LlmCallLedger();
    child.note(call(), "transcript");
    child.note(
      call({ request_id: "req_2", message_id: "msg_2" }),
      "transcript",
    );
    root.absorb(child.state());
    expect(root.note(call(), "collector")).toEqual({
      kind: "duplicate",
      of: "otel_log",
    });
    expect(
      root.note(call({ request_id: "req_2", message_id: "msg_2" }), "otel_log"),
    ).toEqual({ kind: "duplicate", of: "transcript" });
  });

  it("forgets its oldest keys when an absorb takes it past its capacity", () => {
    const root = new LlmCallLedger();
    root.note({ request_id: "req_root" }, "otel_log");
    const child = new LlmCallLedger();
    for (let i = 0; i < LLM_CALL_LEDGER_CAPACITY; i += 1) {
      child.note({ request_id: `req_${i}` }, "transcript");
    }
    root.absorb(child.state());
    expect(root.state().keys).toHaveLength(LLM_CALL_LEDGER_CAPACITY);
    expect(root.note({ request_id: "req_root" }, "transcript")).toEqual({
      kind: "first",
    });
    expect(
      root.note(
        { request_id: `req_${LLM_CALL_LEDGER_CAPACITY - 1}` },
        "otel_log",
      ),
    ).toEqual({ kind: "duplicate", of: "transcript" });
  });
});
