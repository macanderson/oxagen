// audit-exempt: opening the steering PR publishes nothing (nothing steers until a person merges it); the kernel's capability.invoke_* audit records the call, and a refused identity claim is recorded as a forbidden deny.
//
// steering.propose.ts: propose_steering (steering-repo-spec, Agent use and
// Steering PR flow; #5134).
//
// An agent on Oxagen's MCP server opens a steering PR on its workspace's
// steering repo without a clone. Flow:
//   1. Check the caller's role against the contract.
//   2. Find the proposing agent and its run from the request's credential
//      (steering.proposer.ts). A call that resolves to no agent, or to an
//      agent with no run Oxagen watched, is refused before anything is read.
//   3. Refuse a file only Oxagen writes, and a record that types id or hash,
//      names its own provenance.agent, or claims provenance.source: run.
//   4. Write provenance into each record: source: proposal, the run as uri,
//      and the agent (steering-repo/propose.ts).
//   5. Name the branch for the folder the files change, and open the PR
//      through the steering PR opener (tools.pr.open.ts). The opener refuses
//      a change to a managed block, writes one commit, opens the PR, and
//      reports the steering checks as the "Oxagen steering" check.
//
// Every refusal comes before the first write.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { steeringPropose } from "@oxagen/oxagen/contracts/steering.propose";
import { assertContractRole } from "./lib/capability-role-guard";
import {
  isRecordPath,
  ownedPathRefusal,
  proposalBranch,
  proposalPullRequestBody,
  proposalPullRequestOpener,
  proposalUri,
  stampProposalProvenance,
} from "./steering-repo/propose";
import {
  resolveProposingAgent,
  type ProposingAgentResolver,
} from "./steering.proposer";
import type { ToolsPullRequestFile, ToolsPullRequestOpener } from "./tools.pr.open";

export interface SteeringProposeDeps {
  /** The agent behind the request and its run. */
  proposer: ProposingAgentResolver;
  /** The steering PR opener with the proposal's rules (steering-repo/propose.ts). */
  opener: ToolsPullRequestOpener;
  now: () => Date;
}

export type SteeringProposeHandler = CapabilityHandler<typeof steeringPropose>;

export function createSteeringProposeHandler(
  deps: SteeringProposeDeps,
): SteeringProposeHandler {
  return async (input, ctx) => {
    await assertContractRole(steeringPropose, ctx);

    const proposer = await deps.proposer(ctx);
    if (proposer === null) {
      throw new HandlerError({
        code: "forbidden",
        reason: "no_proposing_agent",
        message:
          "propose_steering needs an agent Oxagen knows. Call it through the Oxagen local gateway, from a machine enrolled on a runtime that an agents/<name>.toml file in the steering repo names.",
      });
    }
    if (proposer.run === null) {
      throw new HandlerError({
        code: "forbidden",
        reason: "no_watched_run",
        message:
          "propose_steering needs a run Oxagen watches, because each record names the run it came from. Call it through the Oxagen local gateway from a harness with Tacho installed. If the run just started, try again once Oxagen has recorded it.",
      });
    }

    const owned = ownedPathRefusal(input.files.map((file) => file.path));
    if (owned !== null) throw owned;

    const provenance = { uri: proposalUri(proposer.run), agent: proposer.agent };
    const files: ToolsPullRequestFile[] = input.files.map((file) => ({
      path: file.path,
      content:
        file.content !== null && isRecordPath(file.path)
          ? stampProposalProvenance(file.path, file.content, provenance)
          : file.content,
    }));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const branch = proposalBranch(
      files.map((file) => file.path),
      deps.now(),
    );
    const opened = await deps.opener.open(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      {
        branch,
        title: input.title,
        body: proposalPullRequestBody({
          agent: proposer.agent,
          run: proposer.run,
          rationale: input.rationale,
          evidence: input.evidence,
          files,
        }),
        commitMessage: `${input.title}\n\nProposed by ${proposer.agent} from run ${proposer.run}.`,
        files,
      },
    );
    return {
      number: opened.number,
      url: opened.url,
      branch: opened.branch,
      head_sha: opened.headSha,
      agent: proposer.agent,
      run: proposer.run,
    };
  };
}

/** The handler register.ts loads for propose_steering. */
export const steeringProposeHandler: SteeringProposeHandler =
  createSteeringProposeHandler({
    proposer: resolveProposingAgent,
    opener: proposalPullRequestOpener,
    now: () => new Date(),
  });
