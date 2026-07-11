import type {
  AgentSandboxSnapshotInput,
  AgentSandboxSnapshotOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.snapshot";
import type { CapabilityContext } from "../types";
import {
  requireDurableDriverForRow,
  getSessionByPublicId,
  recordSnapshot,
  SandboxSessionNotFoundError,
} from "./_sandbox-session";

export type { AgentSandboxSnapshotInput, AgentSandboxSnapshotOutput };

/**
 * Capture a filesystem snapshot of a durable session and record it on the
 * registry row, so a later reap can restore transparently.
 */
export async function agentSandboxSnapshotHandler(
  input: AgentSandboxSnapshotInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxSnapshotOutput> {
  const row = await getSessionByPublicId(ctx, input.sessionId);
  if (!row || row.status === "stopped" || row.status === "gone") {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }

  // Resolve the session's own driver (vendor-neutral), not the deployment default.
  const driver = requireDurableDriverForRow(row.driver);

  const { snapshotId } = await driver.snapshotSession(row.sandboxId);
  await recordSnapshot(ctx, row.id, snapshotId);

  return { snapshotId };
}
