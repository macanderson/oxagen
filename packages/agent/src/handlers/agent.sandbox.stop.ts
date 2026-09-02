import pino from "pino";
import type {
  AgentSandboxStopInput,
  AgentSandboxStopOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.stop";
import type { CapabilityContext } from "../types";
import {
  resolveSessionDriver,
  getSessionByPublicId,
  markSessionStatus,
  SandboxSessionNotFoundError,
} from "./_sandbox-session";

export type { AgentSandboxStopInput, AgentSandboxStopOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "stop_sandbox" },
});

/**
 * Terminate a durable session and retire its registry row.
 *
 * The row is what we own, so retirement (markSessionStatus) MUST always succeed
 * — stop never throws for a retirable row. The provider `stopSession` call is
 * strictly best-effort (a sandbox that is already gone, or a provider that is
 * unreachable/unconfigured, still lets us retire the row). Design:
 *   1. Read the row FIRST (including soft-deleted) so an already-stopped session
 *      is idempotent and a missing driver never short-circuits retirement.
 *   2. Resolve the driver from the SESSION's `driver` column (vendor-neutral),
 *      not the deployment default — a session created on one provider is always
 *      torn down on that same provider.
 *   3. Retire the row unconditionally.
 */
export async function agentSandboxStopHandler(
  input: AgentSandboxStopInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxStopOutput> {
  const row = await getSessionByPublicId(ctx, input.sessionId, {
    includeDeleted: true,
  });
  if (!row) {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }
  // Already retired (an explicit stop soft-deletes and flips status → stopped):
  // idempotent success, no provider call.
  if (row.status === "stopped") {
    return { stopped: true };
  }

  // A 'gone' sandbox is already dead — skip the provider round-trip and just
  // retire the row. Otherwise resolve the session's own driver; a null result
  // (driver unavailable/unconfigured/not durable) means we retire without a
  // provider call rather than throwing.
  const driver =
    row.status === "gone" ? null : resolveSessionDriver(row.driver);
  if (driver) {
    try {
      await driver.stopSession(row.sandboxId);
    } catch (err) {
      // Sandbox already reaped/terminated, or the provider is unreachable. The
      // registry row is the source of truth — retire it regardless.
      logger.warn(
        { err, sessionId: input.sessionId, driver: row.driver },
        "stop_sandbox: provider stopSession failed; retiring registry row anyway",
      );
    }
  } else if (row.status !== "gone") {
    logger.info(
      { sessionId: input.sessionId, driver: row.driver },
      "stop_sandbox: no durable driver available for the session; retiring registry row without a provider call",
    );
  }

  await markSessionStatus(ctx, row.id, "stopped");
  return { stopped: true };
}
