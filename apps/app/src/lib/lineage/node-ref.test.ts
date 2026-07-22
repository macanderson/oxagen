import { describe, it, expect } from "vitest";
import { lineageNodeRef } from "./node-ref";
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";

function node(
  overrides: Partial<LineageNodeDto> & { runId: string },
): LineageNodeDto {
  return {
    fanoutId: "fanout-1",
    parentRunId: null,
    childFanoutId: null,
    depth: 0,
    capabilityName: "search_web",
    outcome: "completed",
    attempts: 1,
    principal: { id: "p1", kind: "agent", displayName: "Ops Agent" },
    delegationCeiling: null,
    model: "claude-sonnet-5",
    provider: "anthropic",
    spend: { costUsd: 0.42, inputTokens: 10, outputTokens: 5, llmCalls: 1 },
    delegationViolation: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

describe("lineageNodeRef", () => {
  it("keys id on the raw runId (only place the raw id lives)", () => {
    const ref = lineageNodeRef(node({ runId: "sar_abc123" }));
    expect(ref.id).toBe("sar_abc123");
  });

  it("uses capabilityName as the domain label", () => {
    const ref = lineageNodeRef(
      node({ runId: "a", capabilityName: "dispatch_subagent" }),
    );
    expect(ref.label).toBe("dispatch_subagent");
  });

  it("builds a human displayName from capabilityName + principal displayName — never a bare id", () => {
    const ref = lineageNodeRef(
      node({
        runId: "sar_9999999999",
        capabilityName: "search_web",
        principal: { id: "p1", kind: "human", displayName: "Jane Doe" },
      }),
    );
    expect(ref.displayName).toBe("search_web · Jane Doe");
    expect(ref.displayName).not.toContain("sar_9999999999");
  });

  it("falls back gracefully when the principal is unresolved (displayName is always a real string)", () => {
    const ref = lineageNodeRef(
      node({
        runId: "a",
        principal: { id: null, kind: null, displayName: "Unknown principal" },
      }),
    );
    expect(ref.displayName).toBe("search_web · Unknown principal");
  });

  it("puts spend fields into the property bag as scalars", () => {
    const ref = lineageNodeRef(
      node({
        runId: "a",
        spend: {
          costUsd: 1.5,
          inputTokens: 100,
          outputTokens: 50,
          llmCalls: 3,
        },
      }),
    );
    expect(ref.properties.spendUsd).toBe(1.5);
    expect(ref.properties.inputTokens).toBe(100);
    expect(ref.properties.outputTokens).toBe(50);
    expect(ref.properties.llmCalls).toBe(3);
  });

  it("omits optional fields (model/provider/parentRunId/childFanoutId) when null", () => {
    const ref = lineageNodeRef(
      node({
        runId: "a",
        model: null,
        provider: null,
        parentRunId: null,
        childFanoutId: null,
      }),
    );
    expect(ref.properties.model).toBeUndefined();
    expect(ref.properties.provider).toBeUndefined();
    expect(ref.properties.parentRunId).toBeUndefined();
    expect(ref.properties.childFanoutId).toBeUndefined();
  });

  it("includes delegationViolation details in the property bag when present", () => {
    const ref = lineageNodeRef(
      node({
        runId: "a",
        delegationViolation: {
          ruleId: "authz_denied",
          message: 'IAM denied "x" for principal: nope',
        },
      }),
    );
    expect(ref.properties.delegationViolationRule).toBe("authz_denied");
    expect(ref.properties.delegationViolationMessage).toBe(
      'IAM denied "x" for principal: nope',
    );
  });

  it("includes the delegation ceiling's human display name when present", () => {
    const ref = lineageNodeRef(
      node({
        runId: "a",
        delegationCeiling: { principalId: "p2", displayName: "Ceiling Human" },
      }),
    );
    expect(ref.properties.delegationCeilingPrincipal).toBe("Ceiling Human");
  });

  it("includes durationMs=0 (falsy but valid) in the property bag", () => {
    const ref = lineageNodeRef(node({ runId: "a", durationMs: 0 }));
    expect(ref.properties.durationMs).toBe(0);
  });
});
