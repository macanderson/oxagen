import { describe, expect, it } from "vitest";
import {
  agentDriverSchema,
  lifecycleEventSchema,
  lifecycleInvocationSchema,
  promptPatchSchema,
} from "./lifecycle";

const EVENTS = [
  "before_turn",
  "before_intelligence",
  "before_model_call",
  "after_model_call",
  "before_tool_call",
  "after_tool_call",
  "after_intelligence",
  "before_finalize",
  "after_turn",
] as const;

describe("lifecycle artifact contracts", () => {
  it("accepts every lifecycle event", () => {
    for (const event of EVENTS)
      expect(lifecycleEventSchema.parse(event)).toBe(event);
  });

  it("requires input mappings to choose pointer or literal exclusively", () => {
    const base = {
      id: "hydrate",
      event: "before_intelligence",
      capability: "build_prompt_patch",
      required: true,
      timeout_ms: 1000,
      on_error: "block",
    } as const;
    expect(
      lifecycleInvocationSchema.parse({
        ...base,
        input: { query: { from: "/turn/input/query", required: true } },
      }).input,
    ).toBeDefined();
    expect(() =>
      lifecycleInvocationSchema.parse({
        ...base,
        input: { query: { from: "/turn/input/query", literal: "x" } },
      }),
    ).toThrow();
  });

  it("enforces legal when, retry, and continue combinations", () => {
    expect(() =>
      lifecycleInvocationSchema.parse({
        id: "x",
        event: "before_tool_call",
        capability: "authorize_tool",
        required: true,
        timeout_ms: 1000,
        on_error: "block",
        when: "failure",
      }),
    ).toThrow();
    expect(() =>
      lifecycleInvocationSchema.parse({
        id: "x",
        event: "before_turn",
        capability: "record_turn",
        required: true,
        timeout_ms: 1000,
        on_error: "continue",
      }),
    ).toThrow();
    expect(() =>
      lifecycleInvocationSchema.parse({
        id: "x",
        event: "before_turn",
        capability: "record_turn",
        required: true,
        timeout_ms: 1000,
        on_error: "retry",
      }),
    ).toThrow();
  });

  it("limits prompt-patch application to pre-intelligence events", () => {
    expect(() =>
      lifecycleInvocationSchema.parse({
        id: "x",
        event: "after_model_call",
        capability: "build_prompt_patch",
        required: true,
        apply_as: "prompt_patch",
        timeout_ms: 1000,
        on_error: "block",
      }),
    ).toThrow();
  });

  it("accepts bounded prompt patches and rejects unknown fields", () => {
    expect(
      promptPatchSchema.parse({
        operations: [
          { op: "prepend_system_context", content: "Policy" },
          { op: "redact_input_path", path: "/secrets/token" },
          { op: "add_metadata", key: "policy", value: "v1" },
        ],
      }).operations,
    ).toHaveLength(3);
    expect(() =>
      agentDriverSchema.parse({
        delivery: "buffered",
        invocations: [],
        unsafe_extra: true,
      }),
    ).toThrow();
  });
});
