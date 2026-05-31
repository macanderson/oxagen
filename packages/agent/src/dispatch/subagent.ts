import { db, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getInngestClient } from "./inngest-client.js";

export interface FanoutChild {
  capability: string;
  input?: unknown;
  label?: string;
}

export interface DispatchFanoutArgs {
  orgId: string;
  workspaceId: string;
  parentMessageId: string;
  children: FanoutChild[];
}

export interface DispatchedFanout {
  fanoutId: string;
  childMessageIds: string[];
}

// Writes the fanout row + per-child rows transactionally, then emits a
// single Inngest event the runner picks up to execute each child.
export async function dispatchFanout(args: DispatchFanoutArgs): Promise<DispatchedFanout> {
  const childMessageIds = args.children.map(() => randomUUID());
  const { fanoutId } = await db().transaction(async (tx) => {
    const [fan] = await tx
      .insert(schema.subagentFanouts)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        parentMessageId: args.parentMessageId,
        status: "pending",
        totalChildren: args.children.length,
      })
      .returning({ id: schema.subagentFanouts.id });
    if (!fan) throw new Error("fanout insert failed");
    // Single batch insert; never per-child loop (N+1 violation).
    await tx.insert(schema.subagentRuns).values(
      args.children.map((c, i) => ({
        fanoutId: fan.id,
        childMessageId: childMessageIds[i]!,
        capabilityName: c.capability,
        inputPayload: c.input as object,
        status: "pending" as const,
      })),
    );
    return { fanoutId: fan.id };
  });

  await getInngestClient().send({
    name: "agent/subagent.dispatch",
    data: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      fanoutId,
    },
  });

  return { fanoutId, childMessageIds };
}

export interface FanoutSnapshot {
  fanoutId: string;
  status: "pending" | "completed" | "partial" | "timed_out";
  results: Array<{
    childMessageId: string;
    capability: string;
    status: "completed" | "failed" | "pending";
    output: unknown;
    error: string | null;
  }>;
}

export async function readFanout(
  fanoutId: string,
  orgId: string,
): Promise<FanoutSnapshot | null> {
  const [fan] = await db()
    .select({
      id: schema.subagentFanouts.id,
      status: schema.subagentFanouts.status,
    })
    .from(schema.subagentFanouts)
    .where(
      and(eq(schema.subagentFanouts.id, fanoutId), eq(schema.subagentFanouts.orgId, orgId)),
    )
    .limit(1);
  if (!fan) return null;
  // Cap at 500 children to avoid loading unbounded result sets into memory
  // on every poll cycle. Fanouts larger than this indicate a design issue
  // upstream and should be split into chunked fanouts.
  const runs = await db()
    .select({
      childMessageId: schema.subagentRuns.childMessageId,
      capabilityName: schema.subagentRuns.capabilityName,
      status: schema.subagentRuns.status,
      outputPayload: schema.subagentRuns.outputPayload,
      errorReason: schema.subagentRuns.errorReason,
    })
    .from(schema.subagentRuns)
    .where(eq(schema.subagentRuns.fanoutId, fanoutId))
    .limit(500);
  return {
    fanoutId,
    status: (fan.status as FanoutSnapshot["status"]) ?? "pending",
    results: runs.map((r) => ({
      childMessageId: r.childMessageId,
      capability: r.capabilityName,
      status: (r.status as "completed" | "failed" | "pending") ?? "pending",
      output: r.outputPayload,
      error: r.errorReason,
    })),
  };
}
