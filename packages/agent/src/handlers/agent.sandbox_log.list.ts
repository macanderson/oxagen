import type {
  AgentSandboxLogsListInput,
  AgentSandboxLogsListOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox_log.list";
import { fetchSandboxLogs } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";

export type { AgentSandboxLogsListInput, AgentSandboxLogsListOutput };

/**
 * List a durable sandbox session's captured command output for the inspector.
 *
 * Reads straight from ClickHouse (append-only, 14-day TTL) — NOT gated on the
 * session row existing, so a recently-flushed session's logs remain inspectable.
 * Tenant scoping is enforced by the org/workspace filter inside fetchSandboxLogs,
 * so a cross-tenant sessionId simply returns no rows.
 */
export async function agentSandboxLogsListHandler(
  input: AgentSandboxLogsListInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxLogsListOutput> {
  const lines = await fetchSandboxLogs({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    sessionId: input.sessionId,
    level: input.level,
    limit: input.limit,
    sinceMs: input.sinceMs,
  });
  return { lines };
}
