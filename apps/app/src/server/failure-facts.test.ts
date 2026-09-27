// The facts the kernel seam reads off a failed invoke (#3841), read by duck
// typing: the rule from an IAM refusal or a decision rule's verdict, the
// trace id from the active span, the region from OXAGEN_REGION.
import { afterEach, describe, expect, it, vi } from "vitest";

const { currentTraceIds } = vi.hoisted(() => ({
  currentTraceIds: vi.fn(() => ({ trace_id: "", span_id: "" })),
}));
vi.mock("@oxagen/telemetry", () => ({ currentTraceIds }));

const { activeTraceId, decidedByOf, failureFacts } = await import(
  "./failure-facts"
);
const { deployRegion } = await import("./region");

afterEach(() => {
  vi.unstubAllEnvs();
  currentTraceIds.mockReset();
});

describe("decidedByOf", () => {
  it("reads the IAM rule off a denial and a pending approval", () => {
    expect(
      decidedByOf({ code: "authz_denied", decidedBy: "8:default" }),
    ).toEqual({ source: "iam", id: "8:default" });
    expect(
      decidedByOf({ code: "pending_approval", decidedBy: "tier_gate" }),
    ).toEqual({ source: "iam", id: "tier_gate" });
  });

  it("reads a decision rule's id off its verdict", () => {
    expect(
      decidedByOf({
        code: "decision_rule_denied",
        verdict: { ruleId: "rul_freeze", description: "freeze" },
      }),
    ).toEqual({ source: "decision_rule", id: "rul_freeze" });
  });

  it("names nothing for a refusal that carries no rule, or a rule on the wrong code", () => {
    expect(decidedByOf({ code: "authz_denied" })).toBeNull();
    expect(decidedByOf({ code: "authz_denied", decidedBy: "" })).toBeNull();
    expect(
      decidedByOf({ code: "no_handler", decidedBy: "7:role_grant" }),
    ).toBeNull();
    expect(
      decidedByOf({ code: "decision_rule_denied", verdict: null }),
    ).toBeNull();
    expect(decidedByOf("boom")).toBeNull();
    expect(decidedByOf(null)).toBeNull();
  });
});

describe("the trace id", () => {
  it("is the active span's trace, or null when no span is valid", () => {
    currentTraceIds.mockReturnValue({ trace_id: "abc123", span_id: "1" });
    expect(activeTraceId()).toBe("abc123");
    currentTraceIds.mockReturnValue({ trace_id: "", span_id: "" });
    expect(activeTraceId()).toBeNull();
  });

  it("is null when the trace read throws, so a failure never becomes two", () => {
    currentTraceIds.mockImplementation(() => {
      throw new Error("no tracer");
    });
    expect(activeTraceId()).toBeNull();
  });
});

describe("the region", () => {
  it("is OXAGEN_REGION, trimmed, and null when unset or blank", () => {
    vi.stubEnv("OXAGEN_REGION", " us-east-1 ");
    expect(deployRegion()).toBe("us-east-1");
    vi.stubEnv("OXAGEN_REGION", "   ");
    expect(deployRegion()).toBeNull();
    vi.stubEnv("OXAGEN_REGION", undefined);
    expect(deployRegion()).toBeNull();
  });
});

describe("failureFacts", () => {
  it("collects the trace, the region and the request id", () => {
    currentTraceIds.mockReturnValue({ trace_id: "abc123", span_id: "1" });
    vi.stubEnv("OXAGEN_REGION", "us-east-1");
    expect(failureFacts("req-1")).toEqual({
      traceId: "abc123",
      region: "us-east-1",
      requestId: "req-1",
    });
  });
});
