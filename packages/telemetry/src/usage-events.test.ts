// usage-events.test.ts
//
// The allowlist enforced by POST /v1/telemetry/usage lives entirely in
// UsageEventPayloadSchema — these tests are the proof that the schema (a)
// accepts exactly the anonymous/aggregate shape the CLI builds and (b)
// structurally rejects anything that could carry content, PII, or an
// unexpected field, not merely "the client is expected to behave."

import { describe, expect, it } from "vitest";
import {
  parseUsageEventPayload,
  UsageEventPayloadSchema,
  USAGE_EVENT_ALLOWED_KEYS,
} from "./usage-events";

const VALID_PAYLOAD = {
  install_id: "123e4567-e89b-12d3-a456-426614174000",
  session_id: "223e4567-e89b-12d3-a456-426614174000",
  oxagen_version: "2.4.10",
  os: "darwin",
  arch: "arm64",
  command: "solve",
  model_tier: "balanced",
  best_of_n: 3,
  graph_used: 1,
  pipeline_used: 1,
  tui: 0,
  headless: 0,
  byok: 0,
  tool_calls_json: '{"code_graph":3,"grep":1}',
  step_count: 12,
  duration_ms: 45_230,
  error_type: "",
  exit_status: "success",
} as const;

const EXPECTED_ALLOWED_KEYS = [
  "install_id",
  "session_id",
  "oxagen_version",
  "os",
  "arch",
  "command",
  "model_tier",
  "best_of_n",
  "graph_used",
  "pipeline_used",
  "tui",
  "headless",
  "byok",
  "tool_calls_json",
  "step_count",
  "duration_ms",
  "error_type",
  "exit_status",
].sort();

describe("USAGE_EVENT_ALLOWED_KEYS", () => {
  it("is exactly the documented 18-field allowlist — no more, no less", () => {
    expect([...USAGE_EVENT_ALLOWED_KEYS].sort()).toEqual(EXPECTED_ALLOWED_KEYS);
  });

  it("does not include timestamp — that is stamped server-side, never client-supplied", () => {
    expect(USAGE_EVENT_ALLOWED_KEYS).not.toContain("timestamp");
  });
});

describe("UsageEventPayloadSchema — accepts the real shape", () => {
  it("accepts a fully valid payload", () => {
    const result = UsageEventPayloadSchema.safeParse(VALID_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it("accepts every documented model_tier value, including mixed and empty", () => {
    for (const tier of ["fast", "balanced", "precise", "mixed", ""]) {
      const result = UsageEventPayloadSchema.safeParse({
        ...VALID_PAYLOAD,
        model_tier: tier,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts an empty tool_calls_json object (no tools invoked)", () => {
    const result = UsageEventPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      tool_calls_json: "{}",
    });
    expect(result.success).toBe(true);
  });
});

describe("UsageEventPayloadSchema — the allowlist is enforced, not advisory", () => {
  it("rejects a payload carrying an extra, unlisted key (.strict())", () => {
    const result = UsageEventPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      prompt: "fix the login bug in auth.ts",
    });
    expect(result.success).toBe(false);
  });

  it("rejects any of a battery of content-shaped extra keys", () => {
    const contentKeys = [
      "prompt",
      "message",
      "file_path",
      "code",
      "model",
      "api_key",
      "email",
      "user_id",
      "stack_trace",
      "cwd",
    ];
    for (const key of contentKeys) {
      const result = UsageEventPayloadSchema.safeParse({
        ...VALID_PAYLOAD,
        [key]: "anything",
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a payload missing a required field", () => {
    const { command: _command, ...withoutCommand } = VALID_PAYLOAD;
    const result = UsageEventPayloadSchema.safeParse(withoutCommand);
    expect(result.success).toBe(false);
  });

  it("rejects malformed UUIDs for install_id / session_id", () => {
    expect(
      UsageEventPayloadSchema.safeParse({
        ...VALID_PAYLOAD,
        install_id: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      UsageEventPayloadSchema.safeParse({
        ...VALID_PAYLOAD,
        session_id: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects an unlisted model_tier value — e.g. a real model slug", () => {
    const result = UsageEventPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      model_tier: "claude-opus-4-8",
    });
    expect(result.success).toBe(false);
  });

  it("rejects best_of_n / step_count / duration_ms outside their integer column bounds", () => {
    expect(
      UsageEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, best_of_n: 256 })
        .success,
    ).toBe(false); // > UInt8
    expect(
      UsageEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, best_of_n: -1 })
        .success,
    ).toBe(false);
    expect(
      UsageEventPayloadSchema.safeParse({
        ...VALID_PAYLOAD,
        step_count: 65_536,
      }).success,
    ).toBe(false); // > UInt16
    expect(
      UsageEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, duration_ms: 1.5 })
        .success,
    ).toBe(false); // non-integer
  });

  it("rejects a boolean-flag field carrying anything but exactly 0 or 1", () => {
    for (const field of [
      "graph_used",
      "pipeline_used",
      "tui",
      "headless",
      "byok",
    ] as const) {
      expect(
        UsageEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, [field]: 2 })
          .success,
      ).toBe(false);
      expect(
        UsageEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, [field]: true })
          .success,
      ).toBe(false);
    }
  });

  it("rejects command / os / arch / exit_status values that aren't short lowercase identifiers", () => {
    for (const field of ["command", "os", "arch", "exit_status"] as const) {
      expect(
        UsageEventPayloadSchema.safeParse({
          ...VALID_PAYLOAD,
          [field]: "has spaces",
        }).success,
      ).toBe(false);
      expect(
        UsageEventPayloadSchema.safeParse({
          ...VALID_PAYLOAD,
          [field]: "/etc/passwd",
        }).success,
      ).toBe(false);
      expect(
        UsageEventPayloadSchema.safeParse({
          ...VALID_PAYLOAD,
          [field]: "Sentence case.",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an error_type that looks like a message or stack trace, not a category", () => {
    const messageLike = [
      "Error: insufficient credit balance for org acme-corp",
      "TypeError: Cannot read properties of undefined (reading 'foo')\n  at bar.js:12:4",
      "connection refused at 10.0.0.1:5433",
    ];
    for (const value of messageLike) {
      expect(
        UsageEventPayloadSchema.safeParse({
          ...VALID_PAYLOAD,
          error_type: value,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects tool_calls_json values that aren't a flat string->non-negative-integer map", () => {
    const badShapes = [
      '{"grep": "not a number"}', // string value
      '{"grep": -1}', // negative
      '{"grep": 1.5}', // non-integer
      '["grep", "code_graph"]', // array, not an object
      '{"nested": {"grep": 1}}', // nested object
      '{"the full file contents": 1}', // key fails the identifier shape
      "not json at all",
    ];
    for (const value of badShapes) {
      expect(
        UsageEventPayloadSchema.safeParse({
          ...VALID_PAYLOAD,
          tool_calls_json: value,
        }).success,
      ).toBe(false);
    }
  });
});

describe("parseUsageEventPayload", () => {
  it("returns ok:true with the parsed data for a valid payload", () => {
    const result = parseUsageEventPayload(VALID_PAYLOAD);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.command).toBe("solve");
  });

  it("returns ok:false with a short, static error — never the offending value", () => {
    const secretLikeValue = "sk-super-secret-value-should-never-be-echoed";
    const result = parseUsageEventPayload({
      ...VALID_PAYLOAD,
      command: secretLikeValue,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(secretLikeValue);
      expect(result.error).toContain("command");
    }
  });

  it("never throws on garbage input", () => {
    expect(() => parseUsageEventPayload(null)).not.toThrow();
    expect(() => parseUsageEventPayload(undefined)).not.toThrow();
    expect(() =>
      parseUsageEventPayload("a string, not an object"),
    ).not.toThrow();
    expect(() => parseUsageEventPayload(42)).not.toThrow();
    expect(() => parseUsageEventPayload([1, 2, 3])).not.toThrow();
    expect(parseUsageEventPayload(null).ok).toBe(false);
  });
});
