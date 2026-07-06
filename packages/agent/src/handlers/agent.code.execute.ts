import pino from "pino";
import { getSandbox, isSandboxAvailable } from "@oxagen/sandbox";
import { validateWorkspaceFiles } from "@oxagen/sandbox/workspace";
import { insertEvents } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.code.execute" },
});
import type {
  AgentCodeExecuteInput,
  AgentCodeExecuteOutput,
} from "@oxagen/oxagen/contracts/agent.code.execute";
import { injectEnvironmentSecrets } from "./_environment-env";

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

  // Sanitize the untrusted caller env and merge the environment's trusted vault
  // secrets below it (caller wins). The contract no longer transforms env at
  // parse time so this handler owns the whole boundary — see _environment-env.ts
  // for the trust rationale. Reserved keys the caller tried to set are reported
  // back as warnings rather than silently dropped.
  const { env, strippedKeys, injectedKeys } = await injectEnvironmentSecrets(
    ctx,
    input.environmentId,
    input.env,
  );
  // Log injected vault KEY NAMES only — never values (the whole point of the
  // vault is that values never leave it in plaintext logs).
  if (injectedKeys.length > 0) {
    logger.info(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, environmentId: input.environmentId, injectedKeys },
      "agent.code.execute: injected environment secrets",
    );
  }
  const files = input.files ? validateWorkspaceFiles(input.files) : undefined;

  const sandbox = getSandbox();
  const result = await sandbox.run({
    language: input.language,
    code: input.code,
    stdin: input.stdin,
    env,
    files,
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

  const warnings =
    strippedKeys.length > 0
      ? [`reserved env key stripped: ${strippedKeys.join(", ")}`]
      : undefined;

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionMs: result.durationMs,
    timedOut: result.timedOut,
    oomKilled: result.oomKilled,
    ...(warnings ? { warnings } : {}),
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
