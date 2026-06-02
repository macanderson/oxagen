import { getSandbox, applyPolicy, DEFAULT_POLICY } from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";
import type { AgentCodeExecuteInput, AgentCodeExecuteOutput } from "@oxagen/oxagen/contracts/agent.code.execute";

export type { AgentCodeExecuteInput, AgentCodeExecuteOutput };

export async function agentCodeExecuteHandler(
  input: AgentCodeExecuteInput,
  ctx: CapabilityContext,
): Promise<AgentCodeExecuteOutput> {
  // `input` is the parsed contract output (zod defaults already applied at
  // runtime), but Vercel's declaration-emit tsc infers the defaulted/required
  // fields as optional — coerce each to the SandboxRequest shape with the
  // schema defaults so the required fields are unconditionally present.
  const req = applyPolicy(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      language: input.language ?? "node",
      code: input.code ?? "",
      stdin: input.stdin,
      env: input.env,
      timeoutMs: input.timeoutMs ?? 30_000,
      memoryMb: input.memoryMb ?? 512,
      network: input.network ?? "deny",
    },
    DEFAULT_POLICY,
  );
  const sandbox = getSandbox();
  // materialize-tools.ts already wraps every capability invocation with an
  // insertToolInvocation call (OXA-1351). This handler must NOT write a
  // second row — a duplicate write per code.execute call corrupts credit
  // metering. The invocation_id, latency_ms, and status are recorded by
  // the wrapper with real wall-clock timing from the materialize layer.
  //
  // History: an earlier version inserted a row here with latency_ms:0 and
  // a second invocation_id, causing a double-count in tool_invocations and
  // every billing rollup. Removed in OXA-1425.
  return sandbox.run(req);
}
