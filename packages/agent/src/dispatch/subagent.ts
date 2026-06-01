import { db, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Inngest } from "inngest";
import { requireEnv } from "@oxagen/config/env";

const env = requireEnv(["INNGEST_EVENT_KEY"] as const);

// Shared Inngest client. Same `id` as @oxagen/inngest-functions so events
// route to the registered handlers (served from apps/api /api/inngest).
const inngest = new Inngest({ id: "oxagen-runner", eventKey: env.INNGEST_EVENT_KEY });

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
  /**
   * Current nesting depth of the dispatch (OXA-1498: infinite fanout guard).
   * Default 0 (root dispatch). Incremented by the caller for each nested level.
   * The Inngest executor rejects fanouts that exceed MAX_FANOUT_DEPTH (3).
   * Carried in the event payload only — NOT a DB column.
   */
  depth?: number;
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

  // Carry depth in the event payload so the executor can enforce the depth
  // guard without a DB column (OXA-1498: infinite fanout protection).
  const currentDepth = args.depth ?? 0;
  await inngest.send({
    name: "agent/subagent.dispatch",
    data: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      fanoutId,
      // Child executions are at currentDepth + 1. The executor checks this
      // and stops when depth > MAX_FANOUT_DEPTH (3).
      depth: currentDepth + 1,
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
    .select()
    .from(schema.subagentFanouts)
    .where(
      and(eq(schema.subagentFanouts.id, fanoutId), eq(schema.subagentFanouts.orgId, orgId)),
    )
    .limit(1);
  if (!fan) return null;
  const runs = await db()
    .select()
    .from(schema.subagentRuns)
    .where(eq(schema.subagentRuns.fanoutId, fanoutId));
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
