import { describe, expect, it } from "vitest";
import { telemetryStellaIngest } from "./telemetry.stella.ingest";

const EVENT_ID = `evt_${"a".repeat(64)}`;

function validEvent() {
  return {
    schema: "stella.operational.v1",
    event_class: "execution_rollup",
    event_id: EVENT_ID,
    enrollment_id: "enrollment_01",
    organization_id: "organization_01",
    workspace_id: "workspace_01",
    provider: "anthropic",
    model: "anthropic/claude-sonnet-4",
    outcome: "completed",
    duration_ms: 1_250,
    input_tokens: 120,
    output_tokens: 45,
    cost_microusd: 1_500,
    tool_call_count: 3,
    changed_file_count: 2,
    produced_output: true,
  };
}

function validBatch() {
  return {
    schema: "stella.operational.batch.v1",
    events: [validEvent()],
  };
}

describe("telemetryStellaIngest", () => {
  it("accepts the exact Stella operational batch wire schema", () => {
    expect(telemetryStellaIngest.input.parse(validBatch())).toEqual(
      validBatch(),
    );

    expect(
      telemetryStellaIngest.output.parse({
        accepted: 1,
        event_ids: [EVENT_ID],
      }),
    ).toEqual({ accepted: 1, event_ids: [EVENT_ID] });
  });

  it("rejects unknown batch and event fields", () => {
    expect(
      telemetryStellaIngest.input.safeParse({
        ...validBatch(),
        payload: { prompt: "forbidden" },
      }).success,
    ).toBe(false);
    expect(
      telemetryStellaIngest.input.safeParse({
        ...validBatch(),
        events: [{ ...validEvent(), prompt: "forbidden" }],
      }).success,
    ).toBe(false);
  });

  it("requires the exact batch, event, class, and event-id identifiers", () => {
    const invalidCases = [
      { ...validBatch(), schema: "stella.operational.batch.v2" },
      {
        ...validBatch(),
        events: [{ ...validEvent(), schema: "stella.operational.v2" }],
      },
      {
        ...validBatch(),
        events: [{ ...validEvent(), event_class: "raw_trace" }],
      },
      {
        ...validBatch(),
        events: [{ ...validEvent(), event_id: `evt_${"A".repeat(64)}` }],
      },
      {
        ...validBatch(),
        events: [{ ...validEvent(), event_id: `evt_${"a".repeat(63)}` }],
      },
    ];

    for (const input of invalidCases) {
      expect(telemetryStellaIngest.input.safeParse(input).success).toBe(false);
    }
  });

  it("bounds batches to 1 through 50 events", () => {
    expect(
      telemetryStellaIngest.input.safeParse({ ...validBatch(), events: [] })
        .success,
    ).toBe(false);
    expect(
      telemetryStellaIngest.input.safeParse({
        ...validBatch(),
        events: Array.from({ length: 50 }, validEvent),
      }).success,
    ).toBe(true);
    expect(
      telemetryStellaIngest.input.safeParse({
        ...validBatch(),
        events: Array.from({ length: 51 }, validEvent),
      }).success,
    ).toBe(false);
  });

  it.each(["enrollment_id", "organization_id", "workspace_id"] as const)(
    "requires %s to be 1..=128 bounded ASCII characters",
    (field) => {
      for (const value of ["", "a".repeat(129), "has space", "unicode-é"]) {
        expect(
          telemetryStellaIngest.input.safeParse({
            ...validBatch(),
            events: [{ ...validEvent(), [field]: value }],
          }).success,
        ).toBe(false);
      }
      expect(
        telemetryStellaIngest.input.safeParse({
          ...validBatch(),
          events: [{ ...validEvent(), [field]: "a".repeat(128) }],
        }).success,
      ).toBe(true);
    },
  );

  it("accepts only bounded safe provider and model dimensions", () => {
    for (const [field, value] of [
      ["provider", ""],
      ["provider", "."],
      ["provider", ".."],
      ["provider", "unsafe/provider"],
      ["provider", "a".repeat(161)],
      ["model", "/model"],
      ["model", "provider/"],
      ["model", "provider/model/variant"],
      ["model", "provider/../model"],
      ["model", "model with space"],
      ["model", "a".repeat(161)],
    ] as const) {
      expect(
        telemetryStellaIngest.input.safeParse({
          ...validBatch(),
          events: [{ ...validEvent(), [field]: value }],
        }).success,
      ).toBe(false);
    }

    for (const [provider, model] of [
      ["other", "other"],
      ["openai", "openai/gpt-5.1"],
      ["provider:v1", "model_name:v2"],
    ]) {
      expect(
        telemetryStellaIngest.input.safeParse({
          ...validBatch(),
          events: [{ ...validEvent(), provider, model }],
        }).success,
      ).toBe(true);
    }
  });

  it.each([
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "cost_microusd",
    "tool_call_count",
    "changed_file_count",
  ] as const)("requires %s to be a nonnegative safe integer", (field) => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        telemetryStellaIngest.input.safeParse({
          ...validBatch(),
          events: [{ ...validEvent(), [field]: value }],
        }).success,
      ).toBe(false);
    }
    expect(
      telemetryStellaIngest.input.safeParse({
        ...validBatch(),
        events: [{ ...validEvent(), [field]: 0 }],
      }).success,
    ).toBe(true);
  });

  it("accepts only finalized Stella outcomes and a boolean output flag", () => {
    const outcomes = [
      "completed",
      "error",
      "failed",
      "aborted",
      "cancelled",
      "indeterminate",
      "verification_failed",
      "goal_met",
      "goal_unmet",
    ];
    for (const outcome of outcomes) {
      expect(
        telemetryStellaIngest.input.safeParse({
          ...validBatch(),
          events: [{ ...validEvent(), outcome }],
        }).success,
      ).toBe(true);
    }
    expect(
      telemetryStellaIngest.input.safeParse({
        ...validBatch(),
        events: [{ ...validEvent(), outcome: "running" }],
      }).success,
    ).toBe(false);
    expect(
      telemetryStellaIngest.input.safeParse({
        ...validBatch(),
        events: [{ ...validEvent(), produced_output: 1 }],
      }).success,
    ).toBe(false);
  });

  it("strictly validates the bounded output envelope", () => {
    for (const output of [
      { accepted: 0, event_ids: [] },
      { accepted: 51, event_ids: Array.from({ length: 51 }, () => EVENT_ID) },
      { accepted: 1, event_ids: ["bad"] },
      { accepted: 2, event_ids: [EVENT_ID] },
      { accepted: 1, event_ids: [EVENT_ID], inserted: 1 },
    ]) {
      expect(telemetryStellaIngest.output.safeParse(output).success).toBe(
        false,
      );
    }
  });

  it("is an API-only, scoped, high-sensitivity, non-billable capability", () => {
    expect(telemetryStellaIngest).toMatchObject({
      name: "ingest_stella_operational_telemetry",
      domain: "telemetry",
      mode: "sync",
      surfaces: ["api"],
      layers: ["schema", "api", "unit", "docs"],
      scoped: true,
      noBillingGate: true,
      sensitivity: "high",
      defaultEffect: "deny",
      defaultRoles: {
        org: { Owner: "allow", Admin: "allow" },
        workspace: {},
      },
      agent: {
        requiresApproval: false,
        riskLevel: "high",
        category: "telemetry",
      },
    });
  });
});
