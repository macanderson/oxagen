import { insertEvents } from "@oxagen/telemetry";
import type {
  AgentSandboxExecInput,
  AgentSandboxExecOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.exec";
import type { SandboxExecResult } from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";
import {
  requireDurableDriver,
  getSessionByPublicId,
  touchSession,
  rebindSession,
  markSessionStatus,
  specFromRow,
  SandboxSessionNotFoundError,
  SandboxSessionGoneError,
  type SessionRow,
} from "./_sandbox-session";

export type { AgentSandboxExecInput, AgentSandboxExecOutput };

/**
 * Run a command inside a durable session. If the backing sandbox was reaped
 * between turns, restore it from the last snapshot and retry once (`restored`).
 */
export async function agentSandboxExecHandler(
  input: AgentSandboxExecInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxExecOutput> {
  const driver = requireDurableDriver();

  const row = await getSessionByPublicId(ctx, input.sessionId);
  if (!row || row.status === "stopped" || row.status === "gone") {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }

  let restored = false;
  let result = await driver.execInSession({
    sandboxId: row.sandboxId,
    command: input.command,
    timeoutMs: input.timeoutMs,
    env: input.env,
    stdin: input.stdin,
  });

  // The sandbox was reaped (idle timeout / TTL / OOM). Restore from the last
  // filesystem snapshot and retry exactly once; if there's no snapshot the
  // workspace is unrecoverable and the agent must start a new session.
  if (result.gone) {
    if (!row.snapshotId) {
      await markSessionStatus(ctx, row.id, "gone");
      throw new SandboxSessionGoneError(input.sessionId);
    }
    const handle = await driver.restoreSession(row.snapshotId, specFromRow(row, ctx));
    await rebindSession(ctx, row.id, handle.sandboxId);
    restored = true;
    result = await driver.execInSession({
      sandboxId: handle.sandboxId,
      command: input.command,
      timeoutMs: input.timeoutMs,
      env: input.env,
      stdin: input.stdin,
    });
    if (result.gone) {
      // Restore itself didn't stick — surface rather than loop.
      await markSessionStatus(ctx, row.id, "gone");
      throw new SandboxSessionGoneError(input.sessionId);
    }
  }

  await touchSession(ctx, row.id);
  await emitExecTelemetry(ctx, row, input, result, restored);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionMs: result.durationMs,
    timedOut: result.timedOut,
    restored,
  };
}

// Meter durable-sandbox runtime to ClickHouse. Like agent.code.execute, sandbox
// execution bypasses the @oxagen/ai metering chokepoint, so its infra cost would
// be unpriced without this. Best-effort: never fail a run on an analytics write.
async function emitExecTelemetry(
  ctx: CapabilityContext,
  row: SessionRow,
  input: AgentSandboxExecInput,
  result: SandboxExecResult,
  restored: boolean,
): Promise<void> {
  try {
    await insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        event_type: "agent.sandbox.exec.ran",
        source_system: `handler:${ctx.surface}`,
        stream_offset: null,
        payload: JSON.stringify({
          capability: "agent.sandbox.exec",
          sessionId: input.sessionId,
          image: row.image,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          restored,
          requestId: ctx.requestId,
        }),
        emitted_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // Telemetry is best-effort; never fail a sandbox run on an analytics write.
  }
}
