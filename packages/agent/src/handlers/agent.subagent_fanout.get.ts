import { withTenantDb, schema } from "@oxagen/database";
import { and, asc, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentFanoutGetInput,
  AgentSubagentFanoutGetOutput,
} from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import { FanoutNotFoundError } from "./subagent-errors";

export type { AgentSubagentFanoutGetInput, AgentSubagentFanoutGetOutput };

const PREVIEW_MAX_CHARS = 500;

// Serialized byte size of a JSON payload; 0 when null/undefined or unserializable.
function byteSize(v: unknown): number {
  if (v === null || v === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  } catch {
    return 0;
  }
}

// Bounded JSON preview so the viewer never ships an unbounded payload to the
// client. Null when there is no output yet.
function preview(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(v);
  } catch {
    return null;
  }
  return serialized.length > PREVIEW_MAX_CHARS
    ? `${serialized.slice(0, PREVIEW_MAX_CHARS)}…`
    : serialized;
}

// Load one fan-out plus its child runs. The caller passes the fan-out's
// external public_id, so we resolve the fan-out by public_id but join the child
// runs on the internal uuid — subagent_runs.fanout_id is a uuid FK to
// subagent_fanouts.id (see agent.subagent.dispatch handler).
export async function agentSubagentFanoutGetHandler(
  input: AgentSubagentFanoutGetInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentFanoutGetOutput> {
  const fanout = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.subagentFanouts.id,
        publicId: schema.subagentFanouts.publicId,
        parentMessageId: schema.subagentFanouts.parentMessageId,
        status: schema.subagentFanouts.status,
        totalChildren: schema.subagentFanouts.totalChildren,
        completedChildren: schema.subagentFanouts.completedChildren,
        createdAt: schema.subagentFanouts.createdAt,
        updatedAt: schema.subagentFanouts.updatedAt,
      })
      .from(schema.subagentFanouts)
      .where(
        and(
          eq(schema.subagentFanouts.publicId, input.fanoutId),
          eq(schema.subagentFanouts.orgId, ctx.orgId),
          eq(schema.subagentFanouts.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (!fanout) throw new FanoutNotFoundError(input.fanoutId);

  const runs = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentRuns.publicId,
        capabilityName: schema.subagentRuns.capabilityName,
        status: schema.subagentRuns.status,
        errorReason: schema.subagentRuns.errorReason,
        inputPayload: schema.subagentRuns.inputPayload,
        outputPayload: schema.subagentRuns.outputPayload,
        startedAt: schema.subagentRuns.startedAt,
        completedAt: schema.subagentRuns.completedAt,
      })
      .from(schema.subagentRuns)
      .where(
        and(
          eq(schema.subagentRuns.fanoutId, fanout.id),
          eq(schema.subagentRuns.orgId, ctx.orgId),
          eq(schema.subagentRuns.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(asc(schema.subagentRuns.createdAt)),
  );

  return {
    fanoutId: fanout.publicId,
    parentMessageId: fanout.parentMessageId,
    status: fanout.status as AgentSubagentFanoutGetOutput["status"],
    totalChildren: fanout.totalChildren,
    completedChildren: fanout.completedChildren,
    createdAt: fanout.createdAt.toISOString(),
    updatedAt: fanout.updatedAt.toISOString(),
    runs: runs.map((r) => ({
      runId: r.publicId,
      capabilityName: r.capabilityName,
      status:
        r.status as AgentSubagentFanoutGetOutput["runs"][number]["status"],
      errorReason: r.errorReason,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      durationMs:
        r.startedAt && r.completedAt
          ? r.completedAt.getTime() - r.startedAt.getTime()
          : null,
      inputBytes: byteSize(r.inputPayload),
      outputBytes: byteSize(r.outputPayload),
      outputPreview: preview(r.outputPayload),
    })),
  };
}
