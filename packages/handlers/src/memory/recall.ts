// Which memories reach one request (ADR-206, decision 10).
//
// Recall answers at most 5 memories and 800 tokens. A candidate reaches the
// request only inside its scope: its repositories, its tools, and its paths.
// Each candidate scores the share of its words the request also holds, times
// a weight that halves every `halfLifeDays`. A merged steering record ages
// from its merge, and an unreviewed memory ages from its capture.
import { matchesGlob } from "@oxagen/glob";
import { toolTargetMatches } from "@oxagen/oxagen/steering-repo/names";
import {
  countTokens,
  MEMORY_RECALL_MAX,
  MEMORY_RECALL_TOKENS_MAX,
} from "@oxagen/oxagen/steering-repo/tokens";
import { statementWords } from "./statement";
import type { RecallCandidate, RecallItem, RecallRequest } from "./types";

/** Days for a candidate's weight to halve, until governance/v1 sets it. */
export const RECALL_HALF_LIFE_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Does a target list let the candidate reach the request? A candidate with
 * no list, or an empty one, names no target, so the list does not narrow it.
 */
function reaches(
  targets: readonly string[] | null,
  matches: (target: string) => boolean,
): boolean {
  if (targets === null || targets.length === 0) return true;
  return targets.some(matches);
}

/**
 * May the request's agent see this candidate? A steering record reaches every
 * agent. An unreviewed memory reaches only the agent that wrote it, and only
 * while `recall_unreviewed` is `same-agent`.
 */
function eligible(request: RecallRequest, candidate: RecallCandidate): boolean {
  if (candidate.source === "record") return true;
  return (
    request.recallUnreviewed === "same-agent" &&
    candidate.agent !== null &&
    candidate.agent === request.agent
  );
}

/** Is the candidate inside the request's repository, tools, and paths? */
function inScope(request: RecallRequest, candidate: RecallCandidate): boolean {
  return (
    reaches(candidate.repos, (repo) => repo === request.repository) &&
    reaches(candidate.tools, (target) =>
      request.tools.some((tool) => toolTargetMatches(target, tool)),
    ) &&
    reaches(candidate.appliesTo, (glob) =>
      request.paths.some((path) => matchesGlob(glob, path)),
    )
  );
}

interface Scored {
  candidate: RecallCandidate;
  score: number;
}

/** Highest score first, then the newer candidate, then the lower id. */
function byRank(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score;
  const age = b.candidate.since.getTime() - a.candidate.since.getTime();
  if (age !== 0) return age;
  // 1, -1, or 0, by code unit order, so the order never depends on a locale.
  return (
    Number(a.candidate.id > b.candidate.id) -
    Number(a.candidate.id < b.candidate.id)
  );
}

/**
 * Rank the candidates for one request and keep what fits. Oxagen's in-app
 * agent receives no workspace memories. An item that would take the total
 * past 800 tokens is skipped, and a shorter one after it can still fit.
 */
export function rankRecall(
  request: RecallRequest,
  candidates: RecallCandidate[],
): RecallItem[] {
  if (request.inApp) return [];
  const requestWords = statementWords(request.text).words;
  const halfLifeDays = request.halfLifeDays ?? RECALL_HALF_LIFE_DAYS;
  const now = request.now.getTime();
  const scored: Scored[] = [];
  for (const candidate of candidates) {
    if (!eligible(request, candidate) || !inScope(request, candidate)) continue;
    const words = statementWords(candidate.statement).words;
    if (words.size === 0) continue;
    let shared = 0;
    for (const word of words) if (requestWords.has(word)) shared += 1;
    const ageDays = Math.max(0, (now - candidate.since.getTime()) / DAY_MS);
    const score = (shared / words.size) * 0.5 ** (ageDays / halfLifeDays);
    // One test drops a zero overlap, a weight that underflows, and NaN.
    if (!(score > 0)) continue;
    scored.push({ candidate, score });
  }
  scored.sort(byRank);

  const items: RecallItem[] = [];
  let total = 0;
  for (const { candidate, score } of scored) {
    if (items.length >= MEMORY_RECALL_MAX) break;
    const tokens = countTokens(candidate.statement);
    if (total + tokens > MEMORY_RECALL_TOKENS_MAX) continue;
    items.push({
      id: candidate.id,
      source: candidate.source,
      statement: candidate.statement,
      score,
      tokens,
    });
    total += tokens;
  }
  return items;
}
