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

import { scopedSession } from "@oxagen/ontology/tenant";
import { oversampledLimit } from "@oxagen/ontology/ann";
import { embedText } from "@oxagen/ai";
import type { EntityMutation, DeduplicationResult } from "../types";
import { ALIAS_THRESHOLD, CONFIRM_THRESHOLD } from "../types";
import {
  upsertEntityNode,
  createAliasEdge,
  type UpsertEntityOptions,
} from "../mutations/upsert-entity";

// How many tenant-matching similarity candidates to weigh when picking the
// best dedup match. The index is over-sampled above this so the tenant/type
// filter doesn't starve the candidate set.
const CANDIDATE_LIMIT = 5;

/**
 * A strict-mode non-conformant rejection result. The node is not written.
 */
function rejectedResult(
  conformanceScore: number | undefined,
): DeduplicationResult {
  return {
    principalNodeId: null,
    action: "rejected_nonconformant",
    confidence: 0,
    rejected: true,
    conformanceScore,
  };
}

/**
 * Resolve an EntityMutation against the existing graph.
 *
 * @param opts Optional schema-validation context (pinned active vocabulary
 *   + source metadata) threaded from the pipeline into the node write.
 * @returns DeduplicationResult describing what happened and which node to embed.
 */
export async function resolveEntity(
  mutation: EntityMutation,
  orgId: string,
  opts: UpsertEntityOptions = {},
): Promise<DeduplicationResult> {
  // ── Pass A: exact naturalKey lookup ─────────────────────────────────────────
  const session = scopedSession();
  let passANodeId: string | null = null;
  try {
    const result = await session.run(
      `MATCH (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId})
       RETURN n.publicId AS nodeId`,
      { naturalKey: mutation.naturalKey, orgId },
    );
    const record = result.records[0];
    if (record) {
      passANodeId = record.get("nodeId") as string;
    }
  } finally {
    await session.close();
  }

  if (passANodeId) {
    // Node already exists; upsertEntityNode will update it (ON MATCH SET).
    const updated = await upsertEntityNode(mutation, orgId, opts);
    if (updated.rejected) return rejectedResult(updated.conformanceScore);
    return {
      principalNodeId: passANodeId,
      action: "updated_principal",
      confidence: 1.0,
      matchReason: "natural_key_exact",
      conformanceScore: updated.conformanceScore,
    };
  }

  // ── Pass B: embedding similarity search ──────────────────────────────────────
  // Build a text representation of the incoming entity for embedding.
  const textParts: string[] = [mutation.entityType];
  if (mutation.displayName) textParts.push(mutation.displayName);
  for (const [k, v] of Object.entries(mutation.properties)) {
    if (v == null) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      textParts.push(`${k}:${v}`);
    }
  }
  const entityText = textParts.join("  ");

  const vector = await embedText(entityText, {
    telemetry: {
      orgId: mutation.orgId,
      workspaceId: mutation.workspaceId,
      surface: "ingestion",
      // No execution step for dedup-resolution embeds. Must be a UUID or null —
      // a synthesized `dedup:<naturalKey>` string broke the ClickHouse UUID
      // insert (CANNOT_PARSE_INPUT_ASSERTION_FAILED) and the Postgres uuid
      // credit charge. See @oxagen/telemetry NIL_UUID.
      executionStepId: null,
    },
  });

  // Query the entity_node_embedding_index for similar nodes of the same entityType.
  const searchSession = scopedSession();
  let bestCandidate: {
    nodeId: string;
    displayName?: string;
    email?: string;
    url?: string;
    score: number;
  } | null = null;
  try {
    // The index returns the GLOBAL top-K by similarity, but we only keep nodes
    // matching this org + entityType. Over-fetch (K = limit x factor) so the
    // tenant/type filter doesn't crowd out valid dedup candidates as global
    // graph volume grows, then trim back to CANDIDATE_LIMIT after filtering.
    const result = await searchSession.run(
      `CALL db.index.vector.queryNodes('entity_node_embedding_index', $k, $vector)
       YIELD node AS n, score
       WHERE n.orgId = $orgId AND n.entityType = $entityType
       WITH n, score
       ORDER BY score DESC
       LIMIT $limit
       RETURN n.publicId AS nodeId,
              n.displayName AS displayName,
              n.properties AS properties,
              score`,
      {
        vector,
        orgId,
        entityType: mutation.entityType,
        k: BigInt(oversampledLimit(CANDIDATE_LIMIT)),
        limit: BigInt(CANDIDATE_LIMIT),
      },
    );

    for (const record of result.records) {
      const candidateId = record.get("nodeId") as string;
      const candidateDisplayName = record.get("displayName") as
        | string
        | undefined;
      const rawProperties = record.get("properties") as string | null;
      const embeddingSimilarity = record.get("score") as number;

      let parsedProps: Record<string, unknown> = {};
      if (rawProperties) {
        try {
          parsedProps = JSON.parse(rawProperties) as Record<string, unknown>;
        } catch {
          // malformed stored properties — skip property scoring
        }
      }

      const candidate = {
        displayName: candidateDisplayName,
        email:
          typeof parsedProps["email"] === "string"
            ? parsedProps["email"]
            : undefined,
        url:
          typeof parsedProps["url"] === "string"
            ? parsedProps["url"]
            : undefined,
      };

      const combinedScore = scoreCandidate(
        mutation,
        candidate,
        embeddingSimilarity,
      );

      if (combinedScore >= ALIAS_THRESHOLD) {
        if (!bestCandidate || combinedScore > bestCandidate.score) {
          bestCandidate = {
            nodeId: candidateId,
            ...candidate,
            score: combinedScore,
          };
        }
      }
    }
  } finally {
    await searchSession.close();
  }

  if (bestCandidate) {
    // Create new alias node, then link it to the principal.
    const aliasUpsert = await upsertEntityNode(mutation, orgId, opts);
    if (aliasUpsert.rejected || aliasUpsert.nodeId == null) {
      return rejectedResult(aliasUpsert.conformanceScore);
    }
    const aliasNodeId = aliasUpsert.nodeId;
    const tentative = bestCandidate.score < CONFIRM_THRESHOLD;
    await createAliasEdge(
      aliasNodeId,
      bestCandidate.nodeId,
      {
        confidence: bestCandidate.score,
        matchReason: "name_embedding",
        tentative,
      },
      orgId,
    );
    return {
      principalNodeId: bestCandidate.nodeId,
      aliasNodeId,
      action: tentative ? "created_alias" : "confirmed_alias",
      confidence: bestCandidate.score,
      matchReason: "name_embedding",
      conformanceScore: aliasUpsert.conformanceScore,
    };
  }

  // No match — create a brand-new principal.
  const created = await upsertEntityNode(mutation, orgId, opts);
  if (created.rejected || created.nodeId == null) {
    return rejectedResult(created.conformanceScore);
  }
  return {
    principalNodeId: created.nodeId,
    action: "created_principal",
    confidence: 1.0,
    conformanceScore: created.conformanceScore,
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

  if (
    incomingEmail &&
    candidate.email &&
    incomingEmail.toLowerCase() === candidate.email.toLowerCase()
  ) {
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
 * COST WARNING: `levenshtein` below allocates a full (m+1)×(n+1) matrix, and
 * both operands are source-controlled display names (a PR title, a Slack
 * message, an email subject) with no length cap anywhere upstream. Two 100k-char
 * names are ~10^10 cells — enough to stall or OOM the ingestion worker. Cap the
 * inputs before this is exposed to untrusted-length names.
 *
 * Example: "Thomas Mac Anderson" vs "Mac Anderson" → ~0.72
 *          "Mac Anderson" vs "Mac Anderson" → 1.0
 *          "Mac Anderson" vs "John Smith" → ~0.15
 */
export function fuzzyNameScore(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
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
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

export { ALIAS_THRESHOLD, CONFIRM_THRESHOLD };
