import { db, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Inngest } from "inngest";
import { loadEnv } from "@oxagen/config/env";

const env = loadEnv();

// Shared Inngest client. Same id as apps/runner so events route to the
// runner's function handlers without an extra registration.
const inngest = new Inngest({ id: "oxagen-runner", eventKey: env.INNGEST_EVENT_KEY });

export interface FanoutChild {
  capability: string;
  input: unknown;
  label?: string;
}

export interface DispatchFanoutArgs {
  tenantId: string;
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
        tenantId: args.tenantId,
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

  await inngest.send({
    name: "agent/subagent.dispatch",
    data: {
      tenantId: args.tenantId,
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
  tenantId: string,
): Promise<FanoutSnapshot | null> {
  const [fan] = await db()
    .select()
    .from(schema.subagentFanouts)
    .where(
      and(eq(schema.subagentFanouts.id, fanoutId), eq(schema.subagentFanouts.tenantId, tenantId)),
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
