import type { CapabilityContext } from "../types.js";
import { readFanout } from "../dispatch/subagent.js";

export interface AgentSubagentAggregateInput {
  fanoutId: string;
  waitForCompletion: boolean;
  timeoutMs: number;
}

export interface AgentSubagentAggregateOutput {
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

const POLL_MS = 500;

export async function agentSubagentAggregateHandler(
  input: AgentSubagentAggregateInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentAggregateOutput> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    const snap = await readFanout(input.fanoutId, ctx.orgId);
    if (!snap) {
      throw new Error(`Fanout ${input.fanoutId} not found in tenant`);
    }
    const allDone = snap.results.every((r) => r.status !== "pending");
    if (!input.waitForCompletion || allDone) {
      return snap;
    }
    if (Date.now() >= deadline) {
      return { ...snap, status: "timed_out" };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
