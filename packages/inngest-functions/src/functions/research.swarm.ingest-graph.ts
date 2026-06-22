import { createFunction } from "../create-function";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen/kernel";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";
import "@oxagen/oxagen";

/**
 * research.swarm.ingest-graph — project a completed web-search fan-out into the
 * knowledge graph.
 *
 * The research swarm (research.swarm.start) fans out `web.search` tasks via
 * agent.subagent.dispatch and returns immediately; the searches run and their
 * hits land on the subagent_runs rows — but nothing ever wrote them to Neo4j, so
 * the graph stayed empty (the reported "swarm isn't building the knowledge
 * graph" bug, and the long-standing TODO in research.swarm.start).
 *
 * This closes that loop: when ANY fan-out finishes, we read its child runs and,
 * for the completed `web.search` children, feed each query's hits to graph.ingest
 * — the contract whose whole purpose is "turn raw text into knowledge-graph nodes
 * + edges … the research swarm feeds text here". graph.ingest runs the LLM
 * entity/relationship extraction and idempotently upserts nodes/edges, so
 * re-ingesting the same fan-out is safe (the MERGE is the entity resolution).
 *
 * Gating: a fan-out with no completed web.search children is a no-op, so this is
 * inert for non-search fan-outs (it triggers on the shared fanout-completed
 * event). graph.ingest is invoked through the kernel so IAM, audit, and metering
 * apply, exactly like agent.execute-subagent's child invocations.
 */

const WEB_SEARCH_CAPABILITY = "web.search";
// graph.ingest caps `text` at 100_000 chars; stay safely under it per query.
const MAX_INGEST_TEXT = 90_000;

interface SearchHit {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  snippet?: unknown;
}

/** Build one extraction document from a query and its hits. Defensive about the
 *  payload shape — web.search output is `unknown` at this boundary. */
export function buildIngestText(query: string, hits: SearchHit[]): string {
  const lines: string[] = [];
  if (query.trim().length > 0) lines.push(`Search query: ${query.trim()}`);
  for (const h of hits) {
    const title = typeof h.title === "string" ? h.title : "";
    const body =
      typeof h.content === "string"
        ? h.content
        : typeof h.snippet === "string"
          ? h.snippet
          : "";
    const url = typeof h.url === "string" ? h.url : "";
    const parts = [title, body, url].filter((p) => p.length > 0);
    if (parts.length > 0) lines.push(parts.join(" — "));
  }
  return lines.join("\n").slice(0, MAX_INGEST_TEXT);
}

export const [researchSwarmIngestGraph] = createFunction(
  {
    id: "research.swarm.ingest-graph",
    retries: 1,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "agent/subagent.fanout.completed" },
  async ({ event, step }) => {
    const { orgId, workspaceId, fanoutId } = event.data as {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
    };

    const runs = await step.run("load-search-runs", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .select({
              capabilityName: schema.subagentRuns.capabilityName,
              status: schema.subagentRuns.status,
              inputPayload: schema.subagentRuns.inputPayload,
              outputPayload: schema.subagentRuns.outputPayload,
            })
            .from(schema.subagentRuns)
            .where(
              and(
                eq(schema.subagentRuns.fanoutId, fanoutId),
                eq(schema.subagentRuns.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    const searchRuns = runs.filter(
      (r) => r.capabilityName === WEB_SEARCH_CAPABILITY && r.status === "completed",
    );
    if (searchRuns.length === 0) {
      // Not a web-search fan-out (or nothing succeeded) — inert.
      return { fanoutId, ingested: 0, skipped: true };
    }

    // Same runner context agent.execute-subagent uses for its child invokes, so
    // graph.ingest runs through the kernel with tenant scope, IAM, and metering.
    const ctx = {
      orgId,
      workspaceId,
      userId: null,
      apiKeyId: null,
      requestId: fanoutId,
      surface: "runner" as const,
      messageId: null,
    };

    let ingested = 0;
    for (let i = 0; i < searchRuns.length; i++) {
      const r = searchRuns[i]!;
      const input = (r.inputPayload ?? {}) as { query?: unknown };
      const query = typeof input.query === "string" ? input.query : "";
      const output = (r.outputPayload ?? {}) as { results?: unknown };
      const hits = Array.isArray(output.results) ? (output.results as SearchHit[]) : [];
      if (hits.length === 0) continue;

      const text = buildIngestText(query, hits);
      if (text.trim().length === 0) continue;
      const sourceUrl = hits
        .map((h) => (typeof h.url === "string" ? h.url : ""))
        .find((u) => u.length > 0);

      // One step per query: Inngest checkpoints around each graph.ingest so a
      // mid-fan-out failure never re-runs already-ingested queries. A single
      // query's extraction failure must not abort the rest of the projection.
      const ok = await step.run(`ingest-query-${i}`, async () => {
        try {
          await runInTenantScope({ orgId, workspaceId }, () =>
            invoke(
              "graph.ingest",
              { text, ...(sourceUrl ? { sourceUrl } : {}) },
              ctx,
            ),
          );
          return true;
        } catch (err) {
          logger.warn(
            { err, fanoutId, orgId, query },
            "research.swarm.ingest-graph: graph.ingest failed for query",
          );
          return false;
        }
      });
      if (ok) ingested += 1;
    }

    logger.info(
      { fanoutId, orgId, searchRuns: searchRuns.length, ingested },
      "research.swarm.ingest-graph: projected web-search results into the knowledge graph",
    );
    return { fanoutId, ingested, skipped: false };
  },
);
