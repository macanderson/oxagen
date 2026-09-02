/**
 * Consolidation: Episodic → Semantic distillation.
 *
 * Clusters episodic events by topic similarity, then extracts durable
 * semantic facts from each cluster. This is the core "sleep" function
 * that turns a log of events into structured knowledge.
 *
 * Fact extraction has two paths:
 *   1. An LLM-backed summarizer (`@oxagen/ai` `generateObjectFor`, small/cheap
 *      "fast" tier) that reads the cluster and produces one general fact.
 *   2. A deterministic payload-pattern heuristic used as the fallback whenever
 *      no gateway/model is available (no `AI_GATEWAY_API_KEY`, or no LLM
 *      context passed) or the model call throws.
 */
import { z } from "zod";
import {
  generateObjectFor,
  selectModel,
  type GenerateObjectArgs,
} from "@oxagen/ai";
import type { MemoryRecord, SemanticBody } from "../types";
import { jaccard, jaccardSets, tokenize } from "./text-similarity";

/**
 * Similarity threshold above which a newly distilled fact is treated as an
 * existing fact (boost, not insert). Positive and strict so paraphrases of a
 * genuinely different fact don't collapse.
 */
const FACT_MATCH_THRESHOLD = 0.6;

export interface DistillationConfig {
  /** Minimum cluster size to consider for distillation. Default: 3. */
  minClusterSize: number;
  /** Cosine similarity threshold for clustering. Default: 0.7. */
  clusterThreshold: number;
  /** Initial confidence for newly distilled facts. Default: 0.6. */
  initialConfidence: number;
}

export const DEFAULT_DISTILLATION_CONFIG: DistillationConfig = {
  minClusterSize: 3,
  clusterThreshold: 0.7,
  initialConfidence: 0.6,
};

/**
 * Structured shape the LLM decorator returns. Per ADR-021 §1, the LLM does NOT
 * define the fact's identity — the deterministic {@link extractFactHeuristic}
 * output is the fact-of-record. The model only *decorates*: it picks a clean
 * domain label. Keeping the identity deterministic means paraphrases can't
 * fork one fact into many records.
 */
const DistilledFactSchema = z.object({
  /** Category the fact belongs to (auth, db, api, infra, tooling, …). */
  domain: z.string().min(1),
});

/**
 * Telemetry/scope context required to run the LLM path. Reuses the exact
 * telemetry shape `@oxagen/ai` requires so org/workspace/surface/messageId flow
 * into `token_usage` and the credit ledger. When omitted, distillation uses the
 * deterministic heuristic only.
 */
export interface DistillationLlmOptions {
  telemetry: GenerateObjectArgs<
    z.infer<typeof DistilledFactSchema>
  >["telemetry"];
}

/** True when the Vercel AI Gateway key is configured (LLM path is viable). */
function hasGatewayKey(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY);
}

const DISTILL_SYSTEM_PROMPT =
  "You are given a durable fact distilled deterministically from a cluster of " +
  "agent-memory events, plus the raw events. Your ONLY job is to classify it: " +
  "pick a single short lowercase domain category (e.g. auth, db, api, infra, " +
  "tooling, general). Do not rewrite or restate the fact.";

/** Serialize a payload defensively — never throw on circular/odd values. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "<unserializable>";
  }
}

/** Render the deterministic fact + cluster as a compact classification prompt. */
function buildClusterPrompt(fact: string, cluster: MemoryRecord[]): string {
  const lines = cluster.map((record, i) => {
    const body = record.body as Record<string, unknown>;
    const event = String(body.event ?? record.kind);
    const outcome = String(body.outcome ?? "unknown");
    return `${i + 1}. event=${event} outcome=${outcome} payload=${safeJson(body.payload)}`;
  });
  return (
    `Fact: ${fact}\n\nClassify this fact's domain given the ${cluster.length} ` +
    `events it was distilled from:\n\n${lines.join("\n")}`
  );
}

/** Text used to compare two events for clustering (event type + payload). */
function eventText(event: MemoryRecord): string {
  const body = event.body as Record<string, unknown>;
  const eventType = String(body.event ?? event.kind);
  return `${eventType} ${safeJson(body.payload)}`;
}

/**
 * Cluster episodic events by body similarity.
 *
 * Two-stage, deterministic: first bucket by structural key (kind + event type +
 * domain), then split each bucket into sub-clusters whose members' text
 * similarity meets `config.clusterThreshold` (single-linkage against a
 * representative). Splitting on similarity, not just the structural key,
 * keeps unrelated payloads from being distilled into one blended fact.
 */
export function clusterEvents(
  events: MemoryRecord[],
  config: DistillationConfig,
): MemoryRecord[][] {
  const buckets = new Map<string, MemoryRecord[]>();
  for (const event of events) {
    const body = event.body as Record<string, unknown>;
    const eventType = (body.event as string) ?? event.kind;
    const domain =
      (body.domain as string) ?? (body.tool as string) ?? "general";
    const key = `${event.kind}:${eventType}:${domain}`;
    const group = buckets.get(key) ?? [];
    group.push(event);
    buckets.set(key, group);
  }

  const clusters: MemoryRecord[][] = [];
  for (const bucket of buckets.values()) {
    // Greedy single-linkage sub-clustering by text similarity against each
    // sub-cluster's representative (its first member).
    const subClusters: Array<{ rep: Set<string>; members: MemoryRecord[] }> =
      [];
    for (const event of bucket) {
      const tokens = tokenize(eventText(event));
      const match = subClusters.find(
        (sc) => jaccardSets(sc.rep, tokens) >= config.clusterThreshold,
      );
      if (match) match.members.push(event);
      else subClusters.push({ rep: tokens, members: [event] });
    }
    for (const sc of subClusters) {
      if (sc.members.length >= config.minClusterSize) clusters.push(sc.members);
    }
  }
  return clusters;
}

/**
 * Deterministic fact extraction from a cluster: derive a success-rate / count
 * statement from the shared event type + outcomes. Used directly as the LLM
 * fallback and as the baseline when no gateway is configured.
 */
export function extractFactHeuristic(
  cluster: MemoryRecord[],
): SemanticBody | null {
  if (cluster.length === 0) return null;

  // Extract common patterns
  const bodies = cluster.map((r) => r.body as Record<string, unknown>);
  const firstBody = bodies[0]!;

  // For episodic events: the common event type + outcome pattern becomes the fact
  const eventType = (firstBody.event as string) ?? "";
  const outcomes = bodies
    .map((b) => b.outcome as string | undefined)
    .filter(Boolean);
  const successCount = outcomes.filter((o) => o === "success").length;
  const failureCount = outcomes.filter((o) => o === "failure").length;

  // Generate a fact about this pattern
  const totalOutcomes = successCount + failureCount;
  let fact: string;
  if (totalOutcomes > 0) {
    const successRate = Math.round((successCount / totalOutcomes) * 100);
    fact = `Action "${eventType}" has a ${successRate}% success rate across ${cluster.length} observations`;
  } else {
    fact = `Action "${eventType}" has been observed ${cluster.length} times`;
  }

  const domain =
    (firstBody.domain as string) ?? (firstBody.tool as string) ?? "general";

  return { fact, domain };
}

/**
 * Extract a semantic fact from a cluster of related episodic events.
 *
 * Prefers an LLM summarization (`generateObjectFor`, fast tier) when an LLM
 * context is provided and a gateway key is configured; otherwise, or on any
 * model failure, returns the deterministic {@link extractFactHeuristic} result.
 */
export async function extractFactFromCluster(
  cluster: MemoryRecord[],
  options?: DistillationLlmOptions,
): Promise<SemanticBody | null> {
  if (cluster.length === 0) return null;

  const heuristic = extractFactHeuristic(cluster);
  if (!heuristic) return null;

  // The fact TEXT is the deterministic identity and never comes from the model
  // (ADR-021 §1). No LLM context or no gateway → deterministic path entirely.
  if (!options || !hasGatewayKey()) return heuristic;

  try {
    const { object } = await generateObjectFor({
      schema: DistilledFactSchema,
      // Small/cheap "fast" tier — distillation is a high-volume background job.
      model: selectModel({ tier: "fast" }),
      // Temperature 0 so the decoration (domain label) is itself deterministic.
      temperature: 0,
      system: DISTILL_SYSTEM_PROMPT,
      prompt: buildClusterPrompt(heuristic.fact, cluster),
      telemetry: options.telemetry,
    });
    const domain = object.domain.trim();
    // Decoration only: keep the deterministic fact, adopt the model's domain
    // label when non-empty, else keep the heuristic domain.
    return { fact: heuristic.fact, domain: domain || heuristic.domain };
  } catch {
    // Gateway/model failure must never fail consolidation — fall back.
    return heuristic;
  }
}

/**
 * Run distillation on a batch of unconsolidated episodic events.
 *
 * When `options` is supplied (and a gateway key is configured), each cluster is
 * summarized by the LLM; otherwise the deterministic heuristic is used.
 */
export async function distill(
  events: MemoryRecord[],
  existingFacts: MemoryRecord[],
  config: DistillationConfig = DEFAULT_DISTILLATION_CONFIG,
  options?: DistillationLlmOptions,
): Promise<DistillationResult> {
  const clusters = clusterEvents(events, config);
  const newFacts: DistillationResult["newFacts"] = [];
  const boostedFacts: DistillationResult["boostedFacts"] = [];

  for (const cluster of clusters) {
    const fact = await extractFactFromCluster(cluster, options);
    if (!fact) continue;

    // Check if this fact already exists. NOTE: only pre-existing facts are
    // consulted — two clusters in THIS batch that distill to the same fact both
    // land in `newFacts`. Their bodies are identical, so content addressing
    // collapses them to one record on write, but the caller sees two entries.
    const existing = findExistingFact(fact, existingFacts);
    if (existing) {
      // Boost confidence: seeing the same pattern again reinforces it
      const newConf = Math.min(1.0, existing.confidence + 0.05);
      boostedFacts.push({ recordId: existing.id, newConfidence: newConf });
    } else {
      newFacts.push({
        fact,
        confidence: config.initialConfidence,
        derivedFrom: cluster.map((e) => e.id),
      });
    }
  }

  return {
    newFacts,
    boostedFacts,
    processedEventIds: events.map((e) => e.id),
  };
}

export interface DistillationResult {
  /** Newly extracted semantic facts. */
  newFacts: Array<{
    fact: SemanticBody;
    confidence: number;
    derivedFrom: string[];
  }>;
  /** Existing facts whose confidence should be boosted. */
  boostedFacts: Array<{ recordId: string; newConfidence: number }>;
  /** Events that were processed (to mark as consolidated). */
  processedEventIds: string[];
}

/**
 * Find an existing semantic fact that matches the new one.
 * Matches on domain + similar fact text.
 */
function findExistingFact(
  newFact: SemanticBody,
  existing: MemoryRecord[],
): MemoryRecord | null {
  const newTokens = newFact.fact;
  for (const record of existing) {
    if (record.kind !== "semantic") continue;
    const body = record.body as Record<string, unknown>;
    if (body.domain !== newFact.domain || typeof body.fact !== "string")
      continue;
    // Real token-overlap similarity with a positive threshold. The old
    // `fact.includes(fact.split('"')[1] ?? "")` reduced to `includes("")` for
    // quoteless facts, which is always true — so the first same-domain fact
    // always "matched" and new facts were never inserted.
    if (jaccard(body.fact, newTokens) >= FACT_MATCH_THRESHOLD) {
      return record;
    }
  }
  return null;
}
