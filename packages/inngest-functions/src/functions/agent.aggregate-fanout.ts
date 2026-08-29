import { createFunction } from "../create-function";
import { invoke } from "@oxagen/oxagen/kernel";
import { agentSubagentAggregate } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";
import "@oxagen/oxagen";

/**
 * agent.aggregate-fanout — durable, event-driven completion for a subagent
 * fanout.
 *
 * This replaces the old in-handler busy-wait (a 2s poll for up to 30 minutes
 * inside agent.subagent.aggregate, which exhausted the serverless function
 * timeout). Instead of blocking a function, an orchestrator emits
 * `agent/subagent.aggregate.requested` and this Inngest function parks on
 * `step.waitForEvent` until agent.execute-subagent emits
 * `agent/subagent.fanout.completed` for the same fanoutId — durable waiting
 * that costs no wall-clock in any function. When the fanout finishes (or the
 * wait times out), it reads the merged snapshot via the (non-blocking)
 * agent.subagent.aggregate capability and emits `agent/subagent.aggregated`
 * for downstream consumers (e.g. the research swarm → graph projection).
 */
export const [agentAggregateFanout] = createFunction(
  {
    id: "agent.aggregate-fanout",
    retries: 1,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "agent/subagent.aggregate.requested" },
  async ({ event, step }) => {
    const { orgId, workspaceId, fanoutId, timeoutMs } = event.data as {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
      timeoutMs?: number;
    };

    // Clamp the durable wait to the contract's maximum (30 min). Default 5 min.
    const waitMs = Math.min(
      Math.max(timeoutMs ?? 5 * 60 * 1000, 0),
      30 * 60 * 1000,
    );

    // Park until the fanout signals completion for THIS fanoutId. No polling,
    // no wall-clock burn — Inngest resumes the function when the event arrives
    // or the timeout elapses (returns null on timeout).
    const completion = await step.waitForEvent("await-fanout-completed", {
      event: "agent/subagent.fanout.completed",
      timeout: `${Math.ceil(waitMs / 1000)}s`,
      match: "data.fanoutId",
    });

    // Read the merged snapshot through the kernel so IAM, audit, and metering
    // all apply. The handler is non-blocking: by now the fanout is terminal
    // (event fired) or we time out and report the real in-progress snapshot.
    const aggregate = await step.run("read-aggregate", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        invoke(
          agentSubagentAggregate.name,
          { fanoutId, timeoutMs: waitMs },
          {
            orgId,
            workspaceId,
            userId: null,
            apiKeyId: null,
            requestId: fanoutId,
            surface: "runner" as const,
            messageId: null,
          },
        ),
      ),
    );

    const result = agentSubagentAggregate.output.parse(aggregate);

    if (completion === null) {
      logger.warn(
        { fanoutId, orgId, status: result.status },
        "agent.aggregate-fanout: wait timed out before fanout completion",
      );
    }

    // Emit the aggregated result so orchestrators (swarm, workflows) can react
    // without re-reading. Honest status flows straight through.
    await step.sendEvent("emit-aggregated", {
      name: "agent/subagent.aggregated",
      data: {
        orgId,
        workspaceId,
        fanoutId,
        status: result.status,
        totalChildren: result.totalChildren,
        completedChildren: result.completedChildren,
      },
    });

    return { fanoutId, status: result.status, timedOut: completion === null };
  },
);
