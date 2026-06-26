import { createFunction } from "../create-function";
import { embedText } from "@oxagen/ai";
import { logger } from "../logger";

/**
 * Async embedding worker: generates a vector embedding for an Engram record
 * and writes it back to the Neo4j :EngramMemory node for ANN retrieval.
 *
 * Triggered by `engram/memory.embed` after a record is written to the
 * episodic store. Retry: up to 10 times (embedding API can be rate-limited).
 */
export const [engramEmbedMemory] = createFunction(
  {
    id: "engram.embed-memory",
    retries: 10,
    concurrency: { limit: 10, key: "event.data.orgId" },
  },
  { event: "engram/memory.embed" },
  async ({ event, step }) => {
    const { recordId, orgId, workspaceId, kind, body } = event.data as {
      recordId: string;
      orgId: string;
      workspaceId: string;
      kind: string;
      body: string;
    };

    const embedding = await step.run("generate-embedding", async () => {
      const vector = await embedText(body.slice(0, 2000), {
        telemetry: {
          orgId,
          workspaceId,
          surface: "agent",
          executionStepId: null,
        },
      });
      return vector;
    });

    // Store the embedding on the Neo4j :EngramMemory node for ANN queries.
    // This enables the vector retrieval engine in Phase B.
    await step.run("store-embedding", async () => {
      const { scopedSession } = await import("@oxagen/ontology");
      const { runInTenantScope } = await import("@oxagen/tenancy");
      await runInTenantScope({ orgId, workspaceId }, async () => {
        const s = scopedSession();
        try {
          await s.run(
            /* cypher */ `
              MATCH (m:EngramMemory {recordId: $recordId, orgId: $orgId})
              SET m.embedding = $embedding, m.embeddedAt = datetime()
            `,
            { recordId, embedding },
          );
        } finally {
          await s.close();
        }
      });
    });

    logger.info({ recordId, orgId, kind }, "engram.embed-memory: embedded");
    return { recordId, dimensions: embedding.length };
  },
);
