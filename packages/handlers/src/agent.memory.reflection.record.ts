// audit-exempt: writes nothing; run.reflect stores the reflection from the run's record when the run seals.
//
// agent.memory.reflection.record.ts: record_reflection (ADR-206, #4458).
//
// Like remember_lesson, the call is an acknowledgement. run.reflect reads this
// call's frame when the run seals and stores a reflection/v1 with the agent and
// run Oxagen recorded. Each lesson becomes a memory/v1. The tool grades and
// tool feedback go to each tool server's owner and never steer.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentMemoryReflectionRecord } from "@oxagen/oxagen/contracts/agent.memory.reflection.record";
import { assertContractRole } from "./lib/capability-role-guard";
import { assertWatchedRun } from "./memory/watched-run";

export const agentMemoryReflectionRecordHandler: CapabilityHandler<
  typeof agentMemoryReflectionRecord
> = async (input, ctx) => {
  await assertContractRole(agentMemoryReflectionRecord, ctx);
  assertWatchedRun(ctx, "record_reflection");
  const lessons = input.lessons.length;
  return {
    status: "noted",
    message: `Noted. Oxagen stores the reflection and ${lessons} ${lessons === 1 ? "lesson" : "lessons"} when this run ends.`,
  };
};
