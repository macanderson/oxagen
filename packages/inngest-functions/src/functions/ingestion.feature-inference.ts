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
          .describe("Short product feature name, e.g. 'OAuth Login', 'Billing Dashboard'"),
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

/** Derive the language label from a file natural key's extension. */
export function languageFromKey(fileNaturalKey: string): string {
  const pathPart = fileNaturalKey.split(":").at(-1) ?? fileNaturalKey;
  const ext = pathPart.slice(pathPart.lastIndexOf(".")).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".py") return "python";
  return "unknown";
}

/** Build the user prompt for a single file's symbols. */
export function buildFeaturePrompt(fileNaturalKey: string, symbols: FeatureSymbol[]): string {
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
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = featureSchema.safeParse(JSON.parse(trimmed.slice(start, end + 1)));
    return parsed.success ? parsed.data.features : [];
  } catch {
    return [];
  }
}

/** Minimal Neo4j session surface used by the write helper. */
export interface FeatureWriteSession {
  run(query: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * MERGE Feature nodes + :IMPLEMENTS edges for the accepted (>= threshold)
 * features of one file. Identical Cypher to the original per-file function so
 * the batched and synchronous paths write the graph the same way.
 */
export async function writeAcceptedFeatures(
  session: FeatureWriteSession,
  ctx: { orgId: string; workspaceId: string; connectionId: string; fileNaturalKey: string },
  features: InferredFeature[],
): Promise<number> {
  const accepted = features.filter((f) => f.confidence >= CONFIDENCE_THRESHOLD);
  const { orgId, workspaceId, connectionId, fileNaturalKey } = ctx;

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
          feat.createdAt    = datetime()
        ON MATCH SET
          feat.description  = $description,
          feat.confidence   = $confidence,
          feat.updatedAt    = datetime()`,
      {
        naturalKey: featureNaturalKey,
        orgId,
        name: feature.name,
        description: feature.description,
        workspaceId,
        connectionId,
        confidence: feature.confidence,
      },
    );

    await session.run(
      `MATCH (feat:Feature {naturalKey: $featureNaturalKey, orgId: $orgId})
        MATCH (f:SourceFile {naturalKey: $fileNaturalKey, orgId: $orgId})
        MERGE (feat)-[:IMPLEMENTS]->(f)`,
      { featureNaturalKey, fileNaturalKey, orgId },
    );

    for (const symbolName of feature.relatedSymbolNames) {
      await session.run(
        `MATCH (feat:Feature {naturalKey: $featureNaturalKey, orgId: $orgId})
          MATCH (s:SourceSymbol {fileNaturalKey: $fileNaturalKey, orgId: $orgId, name: $symbolName})
          MERGE (feat)-[:IMPLEMENTS]->(s)`,
        { featureNaturalKey, fileNaturalKey, orgId, symbolName },
      );
    }
  }
  return accepted.length;
}
