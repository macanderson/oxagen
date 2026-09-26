// The frame one MCP gateway call seals (#3971, ADR-194). Every body must
// parse against the strict envelope, because the recorder moves a member no
// body declares into `attrs`, where no reader of a decision looks. A refusal
// once wrote its reason as `policy_reason`, which no body declares, so the
// reason was lost from every decision the daemon sealed for a gateway call.
import { describe, expect, it } from "vitest";
import { digestText } from "../claude-code/context";
import type { Sha256Digest } from "../digest";
import { KIND_BODIES } from "../envelope";
import { gatewayFrameBody } from "./gateway-frame";
import type { GatewayCallRecord } from "./mcp-gateway";

const INPUT: Sha256Digest = `sha256:${"a".repeat(64)}`;
const OUTPUT: Sha256Digest = `sha256:${"b".repeat(64)}`;

function call(over: Partial<GatewayCallRecord> = {}): GatewayCallRecord {
  return {
    sessionId: "mcp-session-1",
    client: "cursor",
    toolName: "list_runs",
    status: "ok",
    durationMs: 42,
    inputDigest: INPUT,
    inputBytes: 18,
    outputDigest: OUTPUT,
    outputBytes: 640,
    ...over,
  };
}

describe("gatewayFrameBody", () => {
  it("seals a call Oxagen served as a tool call that the envelope accepts", () => {
    const { kind, body } = gatewayFrameBody(call());
    expect(kind).toBe("tool_call");
    expect(KIND_BODIES.tool_call.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      tool_name: "list_runs",
      tool_source: "mcp",
      tool_status: "ok",
      tool_input_digest: INPUT,
      tool_output_digest: OUTPUT,
    });
    expect(body).not.toHaveProperty("policy_decision");
  });

  it("seals a refusal as a kernel decision with its rules, in order, and its reason as a code and a digest (regression)", () => {
    const { kind, body } = gatewayFrameBody(
      call({
        status: "rejected",
        refusedReason: 'refused by decision rule "refund-cap": over $500',
        ruleIds: ["refund-cap", "weekend-freeze"],
        outputDigest: undefined,
        outputBytes: undefined,
      }),
    );
    expect(kind).toBe("policy_decision");
    // Every member is declared, so none is moved off the body.
    expect(KIND_BODIES.policy_decision.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      policy_decision: "deny",
      policy_source: "kernel",
      policy_reason_code: "mcp_refused",
      policy_reason_digest: digestText(
        'refused by decision rule "refund-cap": over $500',
      ),
      policy_rules: ["refund-cap", "weekend-freeze"],
    });
    expect(body).not.toHaveProperty("policy_reason");
    expect(body).not.toHaveProperty("tool_output_digest");
  });

  it("names no rule for a refusal that named none, and digests a placeholder reason (negative)", () => {
    for (const ruleIds of [undefined, []]) {
      const { body } = gatewayFrameBody(
        call({ status: "rejected", ...(ruleIds ? { ruleIds } : {}) }),
      );
      expect(KIND_BODIES.policy_decision.safeParse(body).success).toBe(true);
      expect(body).not.toHaveProperty("policy_rules");
      expect(body["policy_reason_digest"]).toBe(digestText("refused"));
    }
  });

  it("is what the envelope refuses once a free-text reason rides the body (negative)", () => {
    // The shape the daemon sealed before this fix: the strict body refuses it,
    // which is why the recorder moved the reason into `attrs`.
    const { body } = gatewayFrameBody(call({ status: "rejected" }));
    expect(
      KIND_BODIES.policy_decision.safeParse({
        ...body,
        policy_reason: "refused",
      }).success,
    ).toBe(false);
  });

  it("seals a tool failure as a tool call, not as a decision", () => {
    const { kind, body } = gatewayFrameBody(
      call({ status: "error", ruleIds: ["refund-cap"] }),
    );
    expect(kind).toBe("tool_call");
    expect(KIND_BODIES.tool_call.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty("policy_rules");
  });
});
