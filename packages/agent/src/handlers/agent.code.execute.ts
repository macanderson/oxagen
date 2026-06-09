import { getSandbox, isSandboxAvailable } from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";
import type {
  AgentCodeExecuteInput,
  AgentCodeExecuteOutput,
} from "@oxagen/oxagen/contracts/agent.code.execute";

export type { AgentCodeExecuteInput, AgentCodeExecuteOutput };

export async function agentCodeExecuteHandler(
  input: AgentCodeExecuteInput,
  ctx: CapabilityContext,
): Promise<AgentCodeExecuteOutput> {
  if (!isSandboxAvailable()) {
    throw new Error(
      "Code execution is not available. Set SANDBOX_ENABLED=true and configure a sandbox driver.",
    );
  }

  const sandbox = getSandbox();
  const result = await sandbox.run({
    language: input.language,
    code: input.code,
    stdin: input.stdin,
    env: input.env,
    timeoutMs: input.timeoutMs,
    memoryMb: input.memoryMb,
    network: input.network,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionMs: result.durationMs,
    timedOut: result.timedOut,
    oomKilled: result.oomKilled,
  };
}
