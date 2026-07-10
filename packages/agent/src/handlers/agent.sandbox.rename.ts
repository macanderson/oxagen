import type {
  AgentSandboxRenameInput,
  AgentSandboxRenameOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.rename";
import type { CapabilityContext } from "../types";
import {
  getSessionByPublicId,
  updateSessionMetadata,
  SandboxSessionNotFoundError,
} from "./_sandbox-session";

export type { AgentSandboxRenameInput, AgentSandboxRenameOutput };

/**
 * Set the human-friendly display label on a durable sandbox session.
 *
 * Pure registry write — no driver round-trip, because the label is display-only
 * (shown in the sandbox list). It merges `label` into the session's metadata
 * jsonb so the frozen session spec (memoryMb, secretSelection, environmentId, …)
 * living in the same blob is preserved. Tenant-scoped by public id; a stopped or
 * unknown session is a not-found error (you cannot rename a retired sandbox).
 */
export async function agentSandboxRenameHandler(
  input: AgentSandboxRenameInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxRenameOutput> {
  // The contract already trims + bounds the label (1-80 chars); trust that.
  const { label } = input;

  const row = await getSessionByPublicId(ctx, input.sessionId);
  if (!row) {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }

  await updateSessionMetadata(ctx, row.id, { label });

  return { sessionId: input.sessionId, label };
}
