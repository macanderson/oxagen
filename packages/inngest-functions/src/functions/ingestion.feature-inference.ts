import { z } from "zod";

/**
 * Shared feature-inference building blocks used by both the per-file function
 * (ingestion.github-infer-features) and the batched function
 * (ingestion.github-infer-features-batch). Keeping the schema, prompt, and
 * Neo4j write in one place means the batch path can never drift from the
 * synchronous path.
 */

/** Minimum confidence to accept a feature inference. */
export const CONFIDENCE_THRESHOLD = 0.6;

export const featureSchema = z.object({
  features: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "Short product feature name, e.g. 'OAuth Login', 'Billing Dashboard'",
          ),
        description: z.string(),
        relatedSymbolNames: z.array(z.string()),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(5),
});

export type InferredFeature = z.infer<typeof featureSchema>["features"][number];

export const FEATURE_SYSTEM_PROMPT =
  "You are a senior software engineer working with a marketing executive to " +
  "develop a succinct set of features that can be used for targeted marketing campaigns. " +
  "Start by analyzing source code to identify product features. " +
  "Extract only genuine product-level features visible to end users, not " +
  "implementation details. Be conservative — only include features you are " +
  "highly confident about that the marketing executive " +
  "also agrees would be useful to call out in targeted marketing campaigns. " +
  "Do not be too specific. Organize features based on domain and keep them " +
  "high level. If no features can be inferred from a file return an empty array.";

/** Symbol shape carried on the infer-features event(s). */
export interface FeatureSymbol {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

/**
 * Extract the connection id from a GitHub file natural key. The key format is
 * `github:${connectionId}:${owner}/${repo}:${filePath}` (see
 * ingestion.github-parse-file), so the connection id is the second colon
 * segment. Returns "" for a key that doesn't match — the reconcile path uses
 * this to write Feature nodes without a stored connectionId. */
export function connectionIdFromKey(fileNaturalKey: string): string {
  const parts = fileNaturalKey.split(":");
  if (parts[0] !== "github" || parts.length < 2) return "";
  const second = parts[1] ?? "";
  // Canonical keys are `github:{owner}/{repo}:{path}` — the second segment is
  // `owner/repo` (contains "/"), NOT a connectionId. Post-unification there is
  // no connectionId in the key, so return "" (the documented empty fallback the
  // reconcile path already handles). Legacy `github:{connectionId}:…` keys (no
  // slash in the second segment) still yield the connectionId for in-flight
  // batches submitted before the reshape.
  return second.includes("/") ? "" : second;
}

/** Derive the language label from a file natural key's extension. */
export function languageFromKey(fileNaturalKey: string): string {
  const pathPart = fileNaturalKey.split(":").at(-1) ?? fileNaturalKey;
  const ext = pathPart.slice(pathPart.lastIndexOf(".")).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".py") return "python";
  return "unknown";
}

/** Build the user prompt for a single file's symbols. */
export function buildFeaturePrompt(
  fileNaturalKey: string,
  symbols: FeatureSymbol[],
): string {
  const language = languageFromKey(fileNaturalKey);
  return (
    `File: ${fileNaturalKey}\n` +
    `Language: ${language}\n` +
    `Symbols:\n` +
    symbols
      .map((s) => `  ${s.kind} ${s.name} (lines ${s.startLine}–${s.endLine})`)
      .join("\n") +
    // The batch path asks for JSON text (batches return text, not structured
    // objects); the synchronous path ignores this trailing instruction because
    // it constrains output via the zod schema. Harmless in both.
    `\n\nRespond with ONLY a JSON object of the form ` +
    `{"features":[{"name","description","relatedSymbolNames":[],"confidence":0-1}]} ` +
    `— no prose, no code fences.`
  );
}

/**
 * Tolerantly parse a model's text answer into validated features. Batches
 * return raw text, so strip any code fence and slice to the outermost JSON
 * object before validating. Returns [] on any failure — a malformed answer must
 * never break the batch write.
 */
export function parseFeaturesFromText(text: string): InferredFeature[] {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = featureSchema.safeParse(
      JSON.parse(trimmed.slice(start, end + 1)),
    );
    return parsed.success ? parsed.data.features : [];
  } catch {
    return [];
  }
}

/** Minimal Neo4j session surface used by the write helper. */
export interface FeatureWriteSession {
  run(query: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Authority provenance for an inferred write — spec finding 7: LLM feature
 *  inference is NEVER authoritative RBAC truth, so every Feature node/edge
 *  carries where it came from. `model` is null when the caller cannot name the
 *  exact slug (the sync path lets @oxagen/ai pick the default). */
export interface InferenceAuthority {
  method: string;
  model: string | null;
}

/**
 * MERGE Feature nodes + :IMPLEMENTS edges for the accepted (>= threshold)
 * features of one file. Shared by the batched and synchronous paths so they
 * write the graph the same way. Every node and edge carries
 * `{ authority:'inferred', method, model, confidence }` — the inference is a
 * bounded suggestion, not authoritative truth (spec finding 7).
 *
 * The Feature→SourceSymbol IMPLEMENTS edges are GONE: SourceSymbol nodes no
 * longer exist in the workspace graph (parse-file reshape), so only the
 * Feature→SourceFile edge remains.
 */
export async function writeAcceptedFeatures(
  session: FeatureWriteSession,
  ctx: {
    orgId: string;
    workspaceId: string;
    connectionId: string;
    fileNaturalKey: string;
    authority: InferenceAuthority;
  },
  features: InferredFeature[],
): Promise<number> {
  const accepted = features.filter((f) => f.confidence >= CONFIDENCE_THRESHOLD);
  const { orgId, workspaceId, connectionId, fileNaturalKey, authority } = ctx;

  for (const feature of accepted) {
    const slugifiedName = feature.name.toLowerCase().replace(/\s+/g, "-");
    const featureNaturalKey = `feature:${workspaceId}:${slugifiedName}`;

    await session.run(
      `MERGE (feat:Feature {naturalKey: $naturalKey, orgId: $orgId})
        ON CREATE SET
          feat.publicId     = randomUUID(),
          feat.name         = $name,
          feat.description  = $description,
          feat.workspaceId  = $workspaceId,
          feat.connectionId = $connectionId,
          feat.confidence   = $confidence,
          feat.authority    = 'inferred',
          feat.method       = $method,
          feat.model        = $model,
          feat.createdAt    = datetime()
        ON MATCH SET
          feat.description  = $description,
          feat.confidence   = $confidence,
          feat.authority    = 'inferred',
          feat.method       = $method,
          feat.model        = $model,
          feat.updatedAt    = datetime()`,
      {
        naturalKey: featureNaturalKey,
        orgId,
        name: feature.name,
        description: feature.description,
        workspaceId,
        connectionId,
        confidence: feature.confidence,
        method: authority.method,
        model: authority.model,
      },
    );

    await session.run(
      `MATCH (feat:Feature {naturalKey: $featureNaturalKey, orgId: $orgId})
        MATCH (f:SourceFile {naturalKey: $fileNaturalKey, orgId: $orgId})
        MERGE (feat)-[impl:IMPLEMENTS]->(f)
        SET impl.authority  = 'inferred',
            impl.method     = $method,
            impl.model      = $model,
            impl.confidence = $confidence`,
      {
        featureNaturalKey,
        fileNaturalKey,
        orgId,
        method: authority.method,
        model: authority.model,
        confidence: feature.confidence,
      },
    );
  }
  return accepted.length;
}
