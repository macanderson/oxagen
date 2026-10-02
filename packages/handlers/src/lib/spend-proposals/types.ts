/**
 * types.ts — the shape every steering record proposal builder returns.
 *
 * A builder reads one finding kind out of a findings pass
 * (`SpendProposalInput`) and returns the proposals it supports. The opener
 * (./open.ts) turns each one into a `propose_record` row.
 */
import type { SpendProposalInput } from "@oxagen/billing/proposal-opener";
import type { FindingKind } from "@oxagen/database/schema";

/** One steering record proposal a finding supports. */
export interface SpendProposal {
  /** The finding kind that supports it. The proposal's source names it. */
  kind: FindingKind;
  /**
   * The lineage the proposal names. A builder derives it from what the
   * proposal is about, so every pass names the same lineage for it and a
   * second pass opens no duplicate.
   */
  lineageId: string;
  /** The record's title; null names the record by its statement. */
  title: string | null;
  /** The record's text: the single-sentence rule. */
  statement: string;
  /** Why the proposal exists, with the figures behind it. */
  rationale: string;
  /** Run public ids the finding cites, at most 500. */
  runs: string[];
  /** Agent keys among those runs, at most 100. */
  agents: string[];
  /** `frame:<run>/<seq>` links to the calls the finding cites, at most 100. */
  evidenceLinks: string[];
}

/** Turns one finding kind out of a findings pass into proposals. */
export interface SpendProposalBuilder {
  kind: FindingKind;
  build(input: SpendProposalInput): SpendProposal[];
}
