import type {
  AgentSandboxStopInput,
  AgentSandboxStopOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.stop";
import type { CapabilityContext } from "../types";
import {
  requireDurableDriver,
  getSessionByPublicId,
  markSessionStatus,
  SandboxSessionNotFoundError,
} from "./_sandbox-session";

export type { AgentSandboxStopInput, AgentSandboxStopOutput };

/**
 * Terminate a durable session and mark its registry row stopped. Idempotent:
 * stopping an already-stopped session is a no-op success.
 */
export async function agentSandboxStopHandler(
  input: AgentSandboxStopInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxStopOutput> {
  const driver = requireDurableDriver();

  const row = await getSessionByPublicId(ctx, input.sessionId);
  if (!row) {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }
  if (row.status === "stopped") {
    return { stopped: true };
  }

  // Best-effort terminate — if the sandbox is already gone, still retire the row.
  try {
    await driver.stopSession(row.sandboxId);
  } catch {
    // Sandbox already reaped/terminated; the registry row is what we own.
  }
  await markSessionStatus(ctx, row.id, "stopped");

  return { stopped: true };
}
