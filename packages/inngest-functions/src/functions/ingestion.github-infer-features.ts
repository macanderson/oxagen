import { z } from "zod";
import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { generateObjectFor } from "@oxagen/ai";
import { logger } from "../logger";

// Minimum confidence to accept a feature inference.
const CONFIDENCE_THRESHOLD = 0.6;

const featureSchema = z.object({
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

/**
 * GitHub infer-features Inngest function.
 *
 * Triggered by "ingestion/github.infer-features". Uses an LLM to identify
 * product-level features from parsed source symbols, then MERGEs Feature nodes
 * and :IMPLEMENTS edges in Neo4j for high-confidence (>= 0.6) results.
 *
 * Concurrency is limited to 10 parallel inferences per org.
 */
export const [ingestionGithubInferFeatures] = createFunction(
  {
    id: "ingestion-github-infer-features",
    retries: 2,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "ingestion/github.infer-features" },
  async ({ event, step }) => {
    const { fileNaturalKey, symbols, orgId, workspaceId, connectionId } =
      event.data as {
        fileNaturalKey: string;
        symbols: Array<{
          kind: string;
          name: string;
          startLine: number;
          endLine: number;
        }>;
        orgId: string;
        workspaceId: string;
        connectionId: string;
      };

    // Derive the language from the natural key extension for the prompt.
    const pathPart = fileNaturalKey.split(":").at(-1) ?? fileNaturalKey;
    const ext = pathPart.slice(pathPart.lastIndexOf(".")).toLowerCase();
    const language =
      ext === ".ts" || ext === ".tsx"
        ? "typescript"
        : ext === ".py"
          ? "python"
          : "unknown";

    // ── Step 1: Infer features via LLM ────────────────────────────────────────
    const inferResult = await step.run("infer", () =>
      generateObjectFor({
        schema: featureSchema,
        system:
          "You are a senior software engineer working with a marketing executive to " +
          "develop a succinct set of features that can be used for targeted marketing campaigns. " +
          "Start by analyzing source code to identify product features. " +
          "Extract only genuine product-level features visible to end users, not " +
          "implementation details. Be conservative — only include features you are " +
          "highly confident about that the marketing executive " +
          "also agrees would be useful to call out in targeted marketing campaigns. " +
          "Do not be too specific. Organize features based on domain and keep them " +
          "high level. If no features can be inferred from a file return an empty array.",
        prompt:
          `File: ${fileNaturalKey}\n` +
          `Language: ${language}\n` +
          `Symbols:\n` +
          symbols
            .map(
              (s: {
                kind: string;
                name: string;
                startLine: number;
                endLine: number;
              }) => `  ${s.kind} ${s.name} (lines ${s.startLine}–${s.endLine})`,
            )
            .join("\n"),
        telemetry: {
          orgId,
          workspaceId,
          surface: "ingestion",
          // No initiating message for ingestion feature-inference. Must be a
          // UUID or null — `feat-infer:<key>` flooded token_usage's UUID column
          // (code-27 parse errors) and broke the uuid credit charge.
          messageId: null,
        },
      }),
    );

    const features = inferResult.object.features;

    logger.info(
      {
        fileNaturalKey,
        orgId,
        totalFeatures: features.length,
        highConfidence: features.filter(
          (f) => f.confidence >= CONFIDENCE_THRESHOLD,
        ).length,
      },
      "ingestion-github-infer-features: inference complete",
    );

    // ── Step 2: Upsert Feature nodes + :IMPLEMENTS edges ──────────────────────
    const acceptedFeatures = features.filter(
      (f) => f.confidence >= CONFIDENCE_THRESHOLD,
    );

    if (acceptedFeatures.length === 0) {
      return { fileNaturalKey, featuresCreated: 0 };
    }

    await step.run("upsert-features", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          for (const feature of acceptedFeatures) {
            const slugifiedName = feature.name
              .toLowerCase()
              .replace(/\s+/g, "-");
            const featureNaturalKey = `feature:${workspaceId}:${slugifiedName}`;

            // MERGE the Feature node itself.
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

            // MERGE :IMPLEMENTS → SourceFile edge.
            await session.run(
              `MATCH (feat:Feature {naturalKey: $featureNaturalKey, orgId: $orgId})
                MATCH (f:SourceFile {naturalKey: $fileNaturalKey, orgId: $orgId})
                MERGE (feat)-[:IMPLEMENTS]->(f)`,
              { featureNaturalKey, fileNaturalKey, orgId },
            );

            // MERGE :IMPLEMENTS → SourceSymbol edges for related symbols.
            for (const symbolName of feature.relatedSymbolNames) {
              // Find matching symbols by name (case-sensitive).
              await session.run(
                `MATCH (feat:Feature {naturalKey: $featureNaturalKey, orgId: $orgId})
                  MATCH (s:SourceSymbol {fileNaturalKey: $fileNaturalKey, orgId: $orgId, name: $symbolName})
                  MERGE (feat)-[:IMPLEMENTS]->(s)`,
                { featureNaturalKey, fileNaturalKey, orgId, symbolName },
              );
            }
          }
        } finally {
          await session.close();
        }
      }),
    );

    logger.info(
      { fileNaturalKey, orgId, featuresCreated: acceptedFeatures.length },
      "ingestion-github-infer-features: completed",
    );

    return { fileNaturalKey, featuresCreated: acceptedFeatures.length };
  },
);
