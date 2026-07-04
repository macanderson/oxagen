import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentResultGetInput,
  AgentSubagentResultGetOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.result.get";
import { SubagentRunNotFoundError } from "./subagent-errors";

export type { AgentSubagentResultGetInput, AgentSubagentResultGetOutput };

// Scoped on-demand read of one child run's FULL payloads — the counterpart to
// the compact-by-default agent.subagent.aggregate (docs/specs/
// graph-mediated-fanout). Tenant scoping is enforced both by RLS and the
// explicit org/workspace predicates; a cross-tenant runId surfaces as
// SubagentRunNotFoundError (→ 404), never another org's data.
export async function agentSubagentResultGetHandler(
  input: AgentSubagentResultGetInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentResultGetOutput> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentRuns.publicId,
        fanoutUuid: schema.subagentRuns.fanoutId,
        capabilityName: schema.subagentRuns.capabilityName,
        status: schema.subagentRuns.status,
        summary: schema.subagentRuns.summary,
        inputPayload: schema.subagentRuns.inputPayload,
        outputPayload: schema.subagentRuns.outputPayload,
        errorReason: schema.subagentRuns.errorReason,
        startedAt: schema.subagentRuns.startedAt,
        completedAt: schema.subagentRuns.completedAt,
        // Join for the fanout's public id — subagent_runs.fanout_id stores the
        // internal uuid (see agent.subagent.dispatch handler).
        fanoutPublicId: schema.subagentFanouts.publicId,
      })
      .from(schema.subagentRuns)
      .innerJoin(
        schema.subagentFanouts,
        eq(schema.subagentRuns.fanoutId, schema.subagentFanouts.id),
      )
      .where(
        and(
          eq(schema.subagentRuns.publicId, input.runId),
          eq(schema.subagentRuns.orgId, ctx.orgId),
          eq(schema.subagentRuns.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );

  if (!row) throw new SubagentRunNotFoundError(input.runId);

  return {
    runId: row.publicId,
    fanoutId: row.fanoutPublicId,
    capabilityName: row.capabilityName,
    status: row.status as AgentSubagentResultGetOutput["status"],
    summary: row.summary,
    input: row.inputPayload,
    output: row.outputPayload,
    errorReason: row.errorReason,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
