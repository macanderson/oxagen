import {
  listApprovalResumes,
  listDedicatedApprovalResumeScopes,
  resumeApprovedCall,
} from "@oxagen/agent/runtime/approval-resume";
import { createFunction } from "../create-function";
import pino from "pino";

const logger = pino({ base: { pkg: "approval.resume" } });

export const [approvalResume] = createFunction(
  { id: "approval/resume", retries: 3, concurrency: { limit: 1 } },
  { cron: "* * * * *" },
  async ({ step }) => {
    const due = await step.run("find-shared-approved-calls", () =>
      listApprovalResumes(),
    );
    const scopes = await step.run(
      "find-dedicated-workspaces",
      listDedicatedApprovalResumeScopes,
    );
    const outcomes: string[] = [];
    for (const ref of due)
      outcomes.push(
        await step.run(`resume-${ref.id}`, () => resumeApprovedCall(ref)),
      );
    for (const scope of scopes) {
      try {
        const dedicated = await step.run(`find-${scope.workspaceId}`, () =>
          listApprovalResumes(scope),
        );
        for (const ref of dedicated)
          outcomes.push(
            await step.run(`resume-${ref.id}`, () => resumeApprovedCall(ref)),
          );
      } catch (error) {
        logger.error(
          { err: error, workspaceId: scope.workspaceId },
          "Approved calls could not be read from a dedicated data plane",
        );
      }
    }
    return { outcomes };
  },
);
