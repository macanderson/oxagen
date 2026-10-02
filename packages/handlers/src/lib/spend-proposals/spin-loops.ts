/**
 * spin-loops.ts — the proposal builder for detector 1, spin and poll loops.
 *
 * The spec's third lever for detector 1: propose a steering record that
 * tells an agent to wait with the harness's own wait or a subagent's result,
 * and to stop polling in a shell loop. The detector writes one `spin_loops`
 * finding per agent, so this builder opens one proposal per agent, with the
 * runs the finding cites as evidence and its figures in the rationale.
 *
 * A record cannot target a named agent, so it reaches every run in the
 * workspace. The statement names the agent, so each agent's record says
 * whom it is for. A finding over runs that name no agent (level `operator`)
 * opens no proposal: there is no agent to tell.
 */
import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import {
  agentLineage,
  firstFrameLinks,
  formatMicros,
  plural,
  PROPOSAL_RUNS_MAX,
} from "./shared";
import type { SpendProposal, SpendProposalBuilder } from "./types";

const KIND = "spin_loops";

/** What a poll costs and what the wait does instead; the same on every proposal. */
const WAIT_LINE =
  "Each poll in a shell loop costs a full request. The harness's own wait and a subagent's result return once, when the work is done.";

const day = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The cost line: every call the finding cites, or the part of them a price
 * covers. The finding counts each call of a counted turn and prices the turn
 * once (#5023), so a priced turn covers all of its calls.
 */
function costLine(draft: FindingDraft): string {
  const amount = formatMicros(draft.savingMicros, draft.currency);
  const { calls, coveredCalls } = draft.evidence;
  return coveredCalls >= calls
    ? `Those calls cost ${amount}.`
    : `${plural(coveredCalls, "call", "calls")} of them have a price, and those cost ${amount}.`;
}

function proposalFor(draft: FindingDraft): SpendProposal {
  const agent = draft.subject;
  return {
    kind: KIND,
    lineageId: agentLineage(KIND, agent),
    title: `Wait rule for ${agent}`,
    statement: `When you run as ${agent} and wait on another run or a subagent, use the harness's own wait or the subagent's result instead of polling in a shell loop.`,
    rationale: `${agent} ran in a spin loop between ${day(draft.windowStart)} and ${day(draft.windowEnd)}. ${draft.why} ${costLine(draft)} ${WAIT_LINE}`,
    runs: draft.citedRuns.slice(0, PROPOSAL_RUNS_MAX),
    agents: [agent],
    evidenceLinks: firstFrameLinks(draft),
  };
}

export const spinLoopProposals: SpendProposalBuilder = {
  kind: KIND,
  build(input) {
    const byAgent = new Map<string, SpendProposal>();
    for (const draft of input.findings) {
      if (draft.kind !== KIND || draft.level !== "agent") continue;
      if (!byAgent.has(draft.subject))
        byAgent.set(draft.subject, proposalFor(draft));
    }
    return [...byAgent.values()];
  },
};
