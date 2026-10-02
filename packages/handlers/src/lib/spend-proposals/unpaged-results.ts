/**
 * unpaged-results.ts — the proposal builder for detector 5, context carry.
 *
 * The spec's last two levers for detector 5: propose earlier compaction for
 * runs that stay over 150,000 tokens, and a fresh subagent for a separable
 * step, so its reads never enter the parent's context. The first lever, a
 * result cap per tool, is MCP Studio's.
 *
 * The detector writes one `unpaged_results` finding per tool, and its draft
 * names no agent. So this builder opens one proposal per tool, with the runs
 * the finding cites as evidence, the first carried call of each run as a
 * frame link, and the finding's figures in the rationale. The record reaches
 * every run in the workspace, and the statement names the tool.
 *
 * A draft carries no context size, so the builder cannot pick out the runs
 * that stayed over 150,000 tokens. The statement gives the threshold as the
 * point to compact at, which ends the carry the finding priced sooner.
 */
import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import {
  draftsBySubject,
  firstFrameLinks,
  formatMicros,
  isoDay,
  plural,
  PROPOSAL_RUNS_MAX,
  subjectLineage,
} from "./shared";
import type { SpendProposal, SpendProposalBuilder } from "./types";

const KIND = "unpaged_results";

/**
 * The context size to compact at. In the spec's sample, requests over
 * 150,000 tokens of context took 64% of spend.
 */
export const COMPACT_AT_TOKENS = 150_000;

/** Why the two levers cut the carry; the same on every proposal. */
const CARRY_LINE =
  "A result stays in the context until the run compacts, so every later request reads it again. A fresh subagent keeps a large result out of the run's own context, and an earlier compaction ends the reads sooner.";

/** The cost line: every read the finding cites, or the reads a price covers. */
function costLine(draft: FindingDraft): string {
  const amount = formatMicros(draft.savingMicros, draft.currency);
  const { calls, coveredCalls } = draft.evidence;
  const page = "more than reading one page of each result would have";
  return coveredCalls >= calls
    ? `Those reads cost ${amount} ${page}.`
    : `${plural(coveredCalls, "read", "reads")} of them have a price, and those cost ${amount} ${page}.`;
}

function proposalFor(draft: FindingDraft): SpendProposal {
  const tool = draft.subject;
  return {
    kind: KIND,
    lineageId: subjectLineage(KIND, tool),
    title: `Context rule for ${tool}`,
    statement: `When a step calls ${tool} for a large result it needs only once, run that step in a fresh subagent, and compact your context as soon as it stays over ${COMPACT_AT_TOKENS.toLocaleString("en-US")} tokens.`,
    rationale: `Runs called ${tool} between ${isoDay(draft.windowStart)} and ${isoDay(draft.windowEnd)}. ${draft.why} ${costLine(draft)} ${CARRY_LINE}`,
    runs: draft.citedRuns.slice(0, PROPOSAL_RUNS_MAX),
    agents: [],
    evidenceLinks: firstFrameLinks(draft),
  };
}

export const unpagedResultProposals: SpendProposalBuilder = {
  kind: KIND,
  build: (input) => draftsBySubject(input, KIND, "tool").map(proposalFor),
};
