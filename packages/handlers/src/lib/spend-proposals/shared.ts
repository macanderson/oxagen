/**
 * shared.ts — what the steering record proposal builders share: the
 * contract's caps, the lineage an agent's proposal names, and the way a
 * figure reads in a rationale.
 */
import { createHash } from "node:crypto";
import type {
  FindingDraft,
  SpendProposalInput,
} from "@oxagen/billing/proposal-opener";
import type { FindingKind, FindingLevel } from "@oxagen/database/schema";

/** The proposal contract's caps (`proposalSupportSchema`). */
export const PROPOSAL_RUNS_MAX = 500;
export const PROPOSAL_AGENTS_MAX = 100;
export const PROPOSAL_LINKS_MAX = 100;

/** The source a proposal carries: the finding kind that supports it. */
export function proposalSource(kind: FindingKind): string {
  return `finding:${kind}`;
}

/**
 * The lineage of one agent's proposal for one finding kind:
 * `ctx.spend.<kind>-<12 hex>`, where the hex is a digest of the agent key.
 * An agent key may hold characters a lineage refuses, so the lineage names
 * its digest. Every pass names the same lineage for the same agent and kind.
 */
export function agentLineage(kind: FindingKind, agentKey: string): string {
  return subjectLineage(kind, agentKey);
}

/**
 * The lineage of one proposal for one finding kind and one finding subject,
 * such as a tool name: `ctx.spend.<kind>-<12 hex>`, where the hex is a digest
 * of the subject. {@link agentLineage} is this lineage for an agent key.
 */
export function subjectLineage(kind: FindingKind, subject: string): string {
  const digest = createHash("sha256").update(subject).digest("hex");
  return `ctx.spend.${kind.replaceAll("_", "-")}-${digest.slice(0, 12)}`;
}

/**
 * The drafts of one finding kind at one level, one per subject, in the order
 * the pass ranks them. The pass writes one finding per kind, level, and
 * subject, so a second draft for a subject is never expected. If one comes,
 * the first is kept.
 */
export function draftsBySubject(
  input: SpendProposalInput,
  kind: FindingKind,
  level: FindingLevel,
): FindingDraft[] {
  const bySubject = new Map<string, FindingDraft>();
  for (const draft of input.findings) {
    if (draft.kind !== kind || draft.level !== level) continue;
    if (!bySubject.has(draft.subject)) bySubject.set(draft.subject, draft);
  }
  return [...bySubject.values()];
}

/** A date as the rationale prints it: `2026-09-01`. */
export function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * `frame:<run>/<seq>` for the first call a finding cites in each run, in the
 * order the finding ranks its runs, at most `PROPOSAL_LINKS_MAX`. A frame
 * link names a seq on the run's own chain, so a call on a subagent's chain
 * gets no link. The run itself is still in the proposal's runs.
 */
export function firstFrameLinks(draft: FindingDraft): string[] {
  const frames = draft.evidence.frames;
  if (frames === undefined) return [];
  const links: string[] = [];
  for (const runId of draft.citedRuns) {
    const own = frames[runId]?.seqs.find((f) => f.sessionUuid === undefined);
    if (own !== undefined) links.push(`frame:${runId}/${own.seq}`);
    if (links.length === PROPOSAL_LINKS_MAX) break;
  }
  return links;
}

/** Micros as money, to the cent: "$1.24", or "1.24 EUR" for a code Intl does not know. */
export function formatMicros(micros: bigint, currency: string): string {
  const units = Number(micros) / 1_000_000;
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(units);
  } catch {
    return `${units.toFixed(2)} ${code}`;
  }
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
