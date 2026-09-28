// audit-exempt: writes nothing; run.reflect stores the lesson from the run's record when the run seals.
//
// agent.memory.lesson.remember.ts: remember_lesson (ADR-206, #4458).
//
// The call is an acknowledgement. Oxagen never takes the agent or the run from
// tool input, so the lesson is stored later from the run's own record:
// run.reflect reads this call's frame when the run seals, checks the input
// against the contract again, and writes a memory/v1. A call this handler
// refuses is a failed frame, and run.reflect skips it.
//
// Only a call the local gateway serves for a watched run is noted. Any other
// caller has no run Oxagen watched, so there is nothing to attribute the
// lesson to, and the handler says so.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentMemoryLessonRemember } from "@oxagen/oxagen/contracts/agent.memory.lesson.remember";
import { assertContractRole } from "./lib/capability-role-guard";
import { assertWatchedRun } from "./memory/watched-run";

export const agentMemoryLessonRememberHandler: CapabilityHandler<
  typeof agentMemoryLessonRemember
> = async (_input, ctx) => {
  await assertContractRole(agentMemoryLessonRemember, ctx);
  assertWatchedRun(ctx, "remember_lesson");
  return {
    status: "noted",
    message:
      "Noted. Oxagen stores the lesson when this run ends, and a curator may propose it as a steering record.",
  };
};
