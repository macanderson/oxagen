/**
 * recurring-runs.ts — the proposal builder for detector 7, recurring runs.
 *
 * The spec's first two levers for detector 7: start the job on a change,
 * such as a new commit or a new issue, instead of on a clock, or run it less
 * often or on a smaller model class. The third lever, a batch at half price,
 * applies to a job that calls the model API directly, which a steering record
 * does not reach.
 *
 * The detector writes one `recurring_runs` finding per agent, and it cites
 * only jobs with a run that changed nothing. So this builder opens one
 * proposal per agent, with the runs the finding cites as evidence and its
 * figures in the rationale. The statement names the agent.
 *
 * A finding over runs that name no agent (level `operator`) opens no
 * proposal: there is no agent to tell. Neither does a finding filed under
 * the workspace, which the detector writes when one job's runs name more than
 * one agent or operator.
 */
import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import {
  agentLineage,
  draftsBySubject,
  firstFrameLinks,
  formatMicros,
  isoDay,
  PROPOSAL_RUNS_MAX,
} from "./shared";
import type { SpendProposal, SpendProposalBuilder } from "./types";

const KIND = "recurring_runs";

/** What a run on a clock pays for; the same on every proposal. */
const CLOCK_LINE =
  "A run that finds nothing to do still pays to find that out.";

/**
 * The cost line. The saving prices each turn of a run that changed nothing.
 * A turn the pass did not read, or one from a run it could not check, is
 * cited with no price.
 */
function costLine(draft: FindingDraft): string {
  const amount = formatMicros(draft.savingMicros, draft.currency);
  const { calls, coveredCalls } = draft.evidence;
  return coveredCalls >= calls
    ? `The runs that changed nothing cost ${amount}.`
    : `The turns with a price in the runs that changed nothing cost ${amount}.`;
}

function proposalFor(draft: FindingDraft): SpendProposal {
  const agent = draft.subject;
  return {
    kind: KIND,
    lineageId: agentLineage(KIND, agent),
    title: `Schedule rule for ${agent}`,
    statement: `Start a recurring job that runs as ${agent} when something changes, such as a new commit or a new issue, instead of on a clock, or run it less often or on a smaller model class.`,
    rationale: `${agent} started runs with a repeated prompt between ${isoDay(draft.windowStart)} and ${isoDay(draft.windowEnd)}. ${draft.why} ${costLine(draft)} ${CLOCK_LINE}`,
    runs: draft.citedRuns.slice(0, PROPOSAL_RUNS_MAX),
    agents: [agent],
    evidenceLinks: firstFrameLinks(draft),
  };
}

export const recurringRunProposals: SpendProposalBuilder = {
  kind: KIND,
  build: (input) => draftsBySubject(input, KIND, "agent").map(proposalFor),
};
