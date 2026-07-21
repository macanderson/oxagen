import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { generateObjectFor } from "@oxagen/ai";
import { logger } from "../logger";
import {
  CONFIDENCE_THRESHOLD,
  FEATURE_SYSTEM_PROMPT,
  buildFeaturePrompt,
  featureSchema,
  writeAcceptedFeatures,
  type FeatureSymbol,
} from "./ingestion.feature-inference";

/**
 * GitHub infer-features Inngest function.
 *
 * Triggered by "ingestion/github.infer-features". Uses an LLM to identify
 * product-level features from parsed source symbols, then MERGEs Feature nodes
 * and :IMPLEMENTS edges in Neo4j for high-confidence (>= 0.6) results.
 *
 * Shares its schema/prompt/graph-write with the batched variant
 * (ingestion.github-infer-features-batch) via ./ingestion.feature-inference so
 * the two paths can never drift. Concurrency is limited to 5 per org.
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
        symbols: FeatureSymbol[];
        orgId: string;
        workspaceId: string;
        connectionId: string;
      };

    // ── Step 1: Infer features via LLM ────────────────────────────────────────
    const inferResult = await step.run("infer", () =>
      generateObjectFor({
        schema: featureSchema,
        system: FEATURE_SYSTEM_PROMPT,
        prompt: buildFeaturePrompt(fileNaturalKey, symbols),
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
    const acceptedCount = features.filter(
      (f) => f.confidence >= CONFIDENCE_THRESHOLD,
    ).length;
    if (acceptedCount === 0) {
      return { fileNaturalKey, featuresCreated: 0 };
    }

    await step.run("upsert-features", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          await writeAcceptedFeatures(
            session,
            {
              orgId,
              workspaceId,
              connectionId,
              fileNaturalKey,
              // Sync path lets @oxagen/ai pick the model, so the exact slug is
              // not surfaced here — record the method, leave model null.
              authority: { method: "llm-feature-inference", model: null },
            },
            features,
          );
        } finally {
          await session.close();
        }
      }),
    );

    logger.info(
      { fileNaturalKey, orgId, featuresCreated: acceptedCount },
      "ingestion-github-infer-features: completed",
    );

    return { fileNaturalKey, featuresCreated: acceptedCount };
  },
);
