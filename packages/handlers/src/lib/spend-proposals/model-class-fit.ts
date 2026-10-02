/**
 * model-class-fit.ts — the proposal builder for detector 4, model class fit.
 *
 * The spec's first two levers for detector 4: propose a model route and an
 * effort level for the agent's steps that only read. The run tuple has no
 * model route field yet (`WorkflowStage.model` and the triage models are
 * types only), so the record states the route in its text. The detector
 * writes one `model_class_fit` finding per agent, so this builder opens one
 * proposal per agent, with the runs the finding cites as evidence and its
 * figures in the rationale.
 *
 * The route names a class, one smaller than the agent's, and no model id, as
 * the Model fit reading does (`@oxagen/oxagen/run-fit`). A finding draft
 * carries no model, so the builder could only name one by parsing the
 * finding's text. That text, which the rationale quotes, names the model the
 * detector repriced against. The effort is the lowest on the ladder Model fit
 * moves between. A finding carries no effort reading, so the builder cannot
 * name a step down from the agent's own.
 *
 * A finding over runs that name no agent (level `operator`) opens no
 * proposal: there is no agent to tell.
 */
import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import { EFFORT_LADDERS } from "@oxagen/oxagen/run-fit";
import {
  agentLineage,
  draftsBySubject,
  firstFrameLinks,
  formatMicros,
  isoDay,
  plural,
  PROPOSAL_RUNS_MAX,
} from "./shared";
import type { SpendProposal, SpendProposalBuilder } from "./types";

const KIND = "model_class_fit";

/** The effort the route proposes: the lowest on Model fit's effort ladder. */
export const READ_ONLY_EFFORT = EFFORT_LADDERS[0]?.[0] ?? "low";

/** Counting rule 3 labels detector 4's figure an estimate. */
const ESTIMATE_LINE =
  "The saving stays an estimate until a replay on the smaller class confirms it.";

/** The saving line: every run the finding cites, or the runs a price covers. */
function savingLine(draft: FindingDraft): string {
  const amount = formatMicros(draft.savingMicros, draft.currency);
  const { calls, coveredCalls } = draft.evidence;
  return coveredCalls >= calls
    ? `The estimated saving is ${amount}.`
    : `${plural(coveredCalls, "run", "runs")} of them have a price, and their estimated saving is ${amount}.`;
}

function proposalFor(draft: FindingDraft): SpendProposal {
  const agent = draft.subject;
  return {
    kind: KIND,
    lineageId: agentLineage(KIND, agent),
    title: `Model route for ${agent}`,
    statement: `When you run as ${agent}, run each step that only reads, such as a search or a file read, in a subagent one model class smaller than yours, such as Sonnet in place of Opus, at ${READ_ONLY_EFFORT} effort.`,
    rationale: `${agent} ran steps that only read between ${isoDay(draft.windowStart)} and ${isoDay(draft.windowEnd)}. ${draft.why} ${savingLine(draft)} ${ESTIMATE_LINE}`,
    runs: draft.citedRuns.slice(0, PROPOSAL_RUNS_MAX),
    agents: [agent],
    evidenceLinks: firstFrameLinks(draft),
  };
}

export const modelClassFitProposals: SpendProposalBuilder = {
  kind: KIND,
  build: (input) => draftsBySubject(input, KIND, "agent").map(proposalFor),
};
