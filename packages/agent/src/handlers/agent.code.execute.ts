import { getSandbox, applyPolicy, DEFAULT_POLICY } from "@oxagen/sandbox";
import { insertToolInvocation } from "@oxagen/telemetry";
import { randomUUID } from "node:crypto";
import type { CapabilityContext } from "../types.js";
import type { AgentCodeExecuteInput, AgentCodeExecuteOutput } from "@oxagen/oxagen/contracts/agent.code.execute";

export type { AgentCodeExecuteInput, AgentCodeExecuteOutput };

export async function agentCodeExecuteHandler(
  input: AgentCodeExecuteInput,
  ctx: CapabilityContext,
): Promise<AgentCodeExecuteOutput> {
  const invocationId = randomUUID();
  const req = applyPolicy(
    { ...input, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    DEFAULT_POLICY,
  );
  const sandbox = getSandbox();
  let result: AgentCodeExecuteOutput;
  let status: "completed" | "failed" | "timed_out" = "completed";
  try {
    result = await sandbox.run(req);
    if (result.timedOut) status = "timed_out";
    else if (result.exitCode !== 0) status = "failed";
  } catch (err) {
    status = "failed";
    throw err;
  } finally {
    await insertToolInvocation({
      invocation_id: invocationId,
      org_id: ctx.orgId,
      workspace_id: ctx.workspaceId,
      capability_name: "agent.code.execute",
      message_id: ctx.requestId,
      parent_message_id: null,
      execution_step_id: null,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set above
      status: status,
      input_size_bytes: Buffer.byteLength(input.code, "utf8"),
      output_size_bytes: 0,
      latency_ms: 0,
      error_class: null,
      external_provider: "",
      external_server_id: null,
      risk_level: "high",
      required_approval: 1,
      surface: ctx.surface,
      provider: "",
      created_at: new Date().toISOString(),
    }).catch(() => undefined);
  }
  return result!;
}
