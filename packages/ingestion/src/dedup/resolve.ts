/**
 * Entity resolution and alias deduplication.
 *
 * Deduplication happens in two passes:
 *
 * Pass A — Exact match (fast path)
 *   Look up the naturalKey in Neo4j. If a node with that key exists → update it.
 *   This handles the common case: the same PR webhook delivered twice, or
 *   a polling overlap with an already-indexed entity.
 *
 * Pass B — Similarity match (alias path)
 *   Only runs when Pass A finds no match. Generates an embedding for the
 *   incoming entity's displayName + key properties, then queries the Neo4j
 *   vector index for similar nodes of the same entityType.
 *
 *   For each candidate above ALIAS_THRESHOLD:
 *     - Score: embedding cosine similarity (0.4 weight)
 *               + exact email/URL property match (0.4 weight if applicable)
 *               + fuzzy display name match (0.2 weight)
 *     - Combined score >= CONFIRM_THRESHOLD  → create + auto-confirm alias
 *     - Combined score >= ALIAS_THRESHOLD    → create tentative alias (requires human review)
 *     - Below threshold → no alias; create new principal
 *
 * The ALIAS_OF edge in Neo4j stores:
 *   { confidence, matchReason, createdAt, confirmedAt?, rejectedAt?, reviewedBy? }
 *
 * Context queries follow ALIAS_OF edges to the principal and return unified data.
 * An agent asking "tell me everything about Mac Anderson" sees all aliases merged.
 */

import type { EntityMutation, DeduplicationResult } from "../types";
import { ALIAS_THRESHOLD, CONFIRM_THRESHOLD } from "../types";

/**
 * Resolve an EntityMutation against the existing graph.
 *
 * @returns DeduplicationResult describing what happened and which node to embed.
 *
 * TODO: implement — requires:
 *   - scopedSession() from @oxagen/ontology/tenant
 *   - embedText() from @oxagen/ai/embed (for Pass B candidates)
 *   - Neo4j MERGE on naturalKey (Pass A)
 *   - Neo4j vector similarity query on entityType nodes (Pass B)
 *   - scoreCandidate() combining embedding + property match
 *   - createPrincipalNode() / createAliasEdge() Neo4j mutations
 */
// TODO(OXA-ingestion): implement entity dedup — for now pass-through
// Requires scopedSession() from @oxagen/ontology/tenant, embedText() from @oxagen/ai/embed,
// Neo4j MERGE on naturalKey (Pass A), and vector similarity query (Pass B).
export async function resolveEntity(
  mutation: EntityMutation,
  _orgId: string,
): Promise<DeduplicationResult> {
  // Pass-through: treat every entity as a new principal until dedup is implemented.
  // This allows the pipeline to run without blocking on the Neo4j integration.
  console.warn("[ingestion] resolveEntity is a pass-through stub — entity dedup not yet implemented");
  return {
    principalNodeId: mutation.naturalKey,
    action: "created_principal",
    confidence: 1.0,
  };
}

/**
 * Score a candidate alias match.
 * Returns a combined confidence score in [0, 1].
 *
 * Weights:
 *   embeddingSimilarity (cosine): 0.40
 *   emailOrUrlExactMatch:        0.40 (0 if no email/URL properties on either side)
 *   fuzzyNameSimilarity:         0.20
 */
export function scoreCandidate(
  incoming: EntityMutation,
  candidate: { displayName?: string; email?: string; url?: string },
  embeddingSimilarity: number,
): number {
  let score = embeddingSimilarity * 0.4;

  const incomingEmail = incoming.properties["email"] as string | undefined;
  const incomingUrl = incoming.properties["url"] as string | undefined;

  if (incomingEmail && candidate.email && incomingEmail.toLowerCase() === candidate.email.toLowerCase()) {
    score += 0.4;
  } else if (incomingUrl && candidate.url && incomingUrl === candidate.url) {
    score += 0.4;
  }

  if (incoming.displayName && candidate.displayName) {
    score += fuzzyNameScore(incoming.displayName, candidate.displayName) * 0.2;
  }

  return Math.min(1, score);
}

/**
 * Normalized Levenshtein-based name similarity in [0, 1].
 * Lowercases and strips punctuation before comparing.
 * Used as one signal in scoreCandidate — never the sole basis for aliasing.
 *
 * Example: "Thomas Mac Anderson" vs "Mac Anderson" → ~0.72
 *          "Mac Anderson" vs "Mac Anderson" → 1.0
 *          "Mac Anderson" vs "John Smith" → ~0.15
 */
export function fuzzyNameScore(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // Bounds are guaranteed by loop construction; non-null assertions are safe.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

export { ALIAS_THRESHOLD, CONFIRM_THRESHOLD };
