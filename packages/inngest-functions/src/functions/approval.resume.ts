import {
  listApprovalResumes,
  resumeApprovedCall,
} from "@oxagen/agent/runtime/approval-resume";
import { createFunction } from "../create-function";

export const [approvalResume] = createFunction(
  { id: "approval/resume", retries: 3, concurrency: { limit: 1 } },
  { cron: "* * * * *" },
  async ({ step }) => {
    const due = await step.run("find-approved-calls", listApprovalResumes);
    const outcomes: string[] = [];
    for (const ref of due)
      outcomes.push(
        await step.run(`resume-${ref.id}`, () => resumeApprovedCall(ref)),
      );
    return { scanned: due.length, outcomes };
  },
);
