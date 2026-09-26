"use server";
// The change a Model fit reading argues for (#3893, ADR-194): a Context pull
// request against the agent's definition file, opened from the Run page.
//
// The write is `commit_agent_definition`, the one the agent's Configuration
// and Source pages make. It commits the edited file to a branch that is never
// the default branch and opens a pull request against it, so nothing changes
// until a person merges it, and every run the agent has sealed keeps the model
// it ran on. The handler checks the viewer's role and the file's schema and
// slug, and the kernel audits the write.
import { agentDefinitionCommit } from "@oxagen/oxagen/contracts/agent.definition.commit";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

type FitChangeDraft = {
  agentId: string;
  branch: string;
  /** The commit and pull request title. */
  message: string;
  /** The whole definition file, with the one key the reading argues for changed. */
  source: string;
};

export type OpenedFitChange = {
  branch: string;
  pullRequest: { number: number; url: string };
};

/** Commits the edited definition to `branch` and opens, or reuses, its pull request. */
export async function openFitChange(
  org: string,
  ws: string,
  draft: FitChangeDraft,
): Promise<ActionResult<OpenedFitChange>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentDefinitionCommit, {
    agentId: draft.agentId,
    branch: draft.branch,
    source: draft.source,
    message: draft.message,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          branch: result.value.branch,
          pullRequest: result.value.pullRequest,
        },
      }
    : result;
}
