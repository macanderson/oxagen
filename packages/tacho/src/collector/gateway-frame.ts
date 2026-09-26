// gateway-frame.ts: the frame body one MCP gateway call seals (#3971,
// ADR-194). The daemon seals it on whichever chain the call lands on; this
// module only says what the body holds, so the body can be checked against
// the strict envelope without booting a daemon.
import { digestText } from "../claude-code/context";
import type { GatewayCallRecord } from "./mcp-gateway";

/** The kind and body of the frame one gateway call seals. */
export interface GatewayFrameBody {
  kind: "tool_call" | "policy_decision";
  body: Record<string, unknown>;
}

/**
 * A call Oxagen served seals as a `tool_call`. A call the control plane
 * refused seals as a `policy_decision` whose source is the kernel.
 *
 * A refusal's reason rides the envelope's declared members: a reason code
 * and a digest of the refusal's message. The recorder moves an undeclared
 * member such as `policy_reason` off the strict body into `attrs`, where no
 * reader of a decision looks, so a free-text reason is never written here.
 * The rules that refused the call are the control plane's `data.ruleIds`, in
 * evaluation order, sealed as `policy_rules` only when it named any.
 */
export function gatewayFrameBody(call: GatewayCallRecord): GatewayFrameBody {
  const refused = call.status === "rejected";
  return {
    kind: refused ? "policy_decision" : "tool_call",
    body: {
      tool_name: call.toolName,
      tool_source: "mcp",
      mcp_server_name: "oxagen",
      mcp_tool_name: call.toolName,
      tool_status: call.status,
      tool_duration_ms: call.durationMs,
      ...(call.inputDigest === undefined
        ? {}
        : {
            tool_input_digest: call.inputDigest,
            tool_input_bytes: call.inputBytes,
          }),
      ...(call.outputDigest === undefined
        ? {}
        : {
            tool_output_digest: call.outputDigest,
            tool_output_bytes: call.outputBytes,
          }),
      ...(refused
        ? {
            policy_decision: "deny",
            policy_source: "kernel",
            policy_reason_code: "mcp_refused",
            policy_reason_digest: digestText(call.refusedReason ?? "refused"),
            ...(call.ruleIds === undefined || call.ruleIds.length === 0
              ? {}
              : { policy_rules: call.ruleIds }),
          }
        : {}),
    },
  };
}
