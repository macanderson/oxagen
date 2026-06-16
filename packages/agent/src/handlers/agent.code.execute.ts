import { getSandbox, isSandboxAvailable } from "@oxagen/sandbox";
import { insertEvents } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";
import {
  sanitizeSandboxEnv,
  type AgentCodeExecuteInput,
  type AgentCodeExecuteOutput,
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

  // Defense in depth: the contract already allowlists env, but a direct handler
  // caller (internal code, tests) bypasses the zod transform — re-sanitize at
  // the sandbox boundary so reserved keys can never reach the sandbox process.
  const env = sanitizeSandboxEnv(input.env);

  const sandbox = getSandbox();
  const result = await sandbox.run({
    language: input.language,
    code: input.code,
    stdin: input.stdin,
    env,
    timeoutMs: input.timeoutMs,
    memoryMb: input.memoryMb,
    network: input.network,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  });

  // Meter sandbox runtime cost → ClickHouse (shared analytics package). Sandbox
  // execution does NOT pass through the @oxagen/ai metering chokepoint, so
  // without this its infra cost — driven by `language` and wall-clock duration —
  // is unpriced. Distinct event_type from tool_invocations, so it never
  // double-counts the materialize-tools row. Best-effort: a telemetry write
  // must never fail a code run.
  await emitRunTelemetry(ctx, input, result);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionMs: result.durationMs,
    timedOut: result.timedOut,
    oomKilled: result.oomKilled,
  };
}

async function emitRunTelemetry(
  ctx: CapabilityContext,
  input: AgentCodeExecuteInput,
  result: { exitCode: number; durationMs: number; timedOut: boolean; oomKilled: boolean },
): Promise<void> {
  try {
    await insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        event_type: "agent.code.execute.ran",
        source_system: `handler:${ctx.surface}`,
        stream_offset: null,
        payload: JSON.stringify({
          capability: "agent.code.execute",
          language: input.language,
          network: input.network,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          oomKilled: result.oomKilled,
          requestId: ctx.requestId,
        }),
        emitted_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // Telemetry is best-effort; never fail a code run on an analytics write.
  }
}
