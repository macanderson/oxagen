import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentSiblingsInput,
  AgentSubagentSiblingsOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.siblings";
import { SubagentRunNotFoundError } from "./subagent-errors";

export type { AgentSubagentSiblingsInput, AgentSubagentSiblingsOutput };

type SiblingRow = AgentSubagentSiblingsOutput["siblings"][number];

// Tier A of Phase 2 graph-mediated fanout (docs/specs/graph-mediated-fanout-
// phase2 §3). Resolve the calling child's fanout and return its siblings as
// compact rows — capability + status + summary + attempts — never their full
// payloads (a sibling's output is one agent.subagent.result.get away).
//
// ONE indexed round trip, no graph hop: we self-join subagent_runs on
// fanout_id (the caller row aliased as `caller`) so the same query both proves
// the caller exists in this tenant scope AND streams back every run sharing its
// fanout. Tenant scoping is enforced on the CALLER row (org + workspace) plus
// RLS — a cross-tenant or unknown runId yields zero rows and surfaces as
// SubagentRunNotFoundError (→ 404), never another org's data. The caller is
// then dropped from the sibling list in memory.
export async function agentSubagentSiblingsHandler(
  input: AgentSubagentSiblingsInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentSiblingsOutput> {
  const caller = alias(schema.subagentRuns, "caller");

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentRuns.publicId,
        capabilityName: schema.subagentRuns.capabilityName,
        status: schema.subagentRuns.status,
        summary: schema.subagentRuns.summary,
        attempts: schema.subagentRuns.attempts,
        errorReason: schema.subagentRuns.errorReason,
        // The fanout's public id, resolved once via the join — subagent_runs.
        // fanout_id stores the internal uuid (see agent.subagent.dispatch).
        fanoutPublicId: schema.subagentFanouts.publicId,
      })
      .from(schema.subagentRuns)
      // caller pins the query to ONE fanout, scoped to this tenant; every row
      // returned therefore shares the caller's fanout.
      .innerJoin(caller, eq(schema.subagentRuns.fanoutId, caller.fanoutId))
      .innerJoin(
        schema.subagentFanouts,
        eq(schema.subagentRuns.fanoutId, schema.subagentFanouts.id),
      )
      .where(
        and(
          eq(caller.publicId, input.runId),
          eq(caller.orgId, ctx.orgId),
          eq(caller.workspaceId, ctx.workspaceId),
        ),
      ),
  );

  // No rows means the caller runId is unknown or cross-tenant — the caller row
  // itself would otherwise self-match, so an empty set is an absent caller.
  const [first] = rows;
  if (!first) throw new SubagentRunNotFoundError(input.runId);

  const fanoutId = first.fanoutPublicId;
  const siblings: SiblingRow[] = rows
    // Exclude the calling run itself — a child asks what OTHERS covered.
    .filter((row) => row.publicId !== input.runId)
    .map((row) => ({
      runId: row.publicId,
      capabilityName: row.capabilityName,
      status: row.status as SiblingRow["status"],
      summary: row.summary,
      attempts: row.attempts,
      errorReason: row.errorReason,
    }));

  return { runId: input.runId, fanoutId, siblings };
}
