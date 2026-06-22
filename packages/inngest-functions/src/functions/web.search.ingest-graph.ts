import { createFunction } from "../create-function";
import { invoke } from "@oxagen/oxagen/kernel";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";
import "@oxagen/oxagen";

/**
 * web.search.ingest-graph — project every web search into the knowledge graph.
 *
 * The web.search handler emits `web/search.completed` after any search that
 * returns hits. EVERY web search routes through that one handler — the in-chat
 * agent calling web.search as a tool, the research swarm's fanned-out children
 * (agent.execute-subagent invokes the capability through the kernel), and the
 * API / MCP / CLI surfaces. So binding ingestion here covers them all uniformly,
 * rather than only the research-swarm fan-out path.
 *
 * For each completed search we feed the query + hits (title — content — url) to
 * graph.ingest — the contract whose whole purpose is "turn raw text into
 * knowledge-graph nodes + edges … the bridge from web-search text to the
 * ontology". graph.ingest runs the LLM entity/relationship extraction and
 * idempotently upserts nodes/edges (the MERGE is the entity resolution), so
 * re-delivery of the same event is safe.
 *
 * graph.ingest is invoked through the kernel so IAM, audit, and metering apply,
 * exactly like agent.execute-subagent's child invocations.
 */

// graph.ingest caps `text` at 100_000 chars; stay safely under it per search.
const MAX_INGEST_TEXT = 90_000;

interface SearchHit {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  snippet?: unknown;
}

/** Build one extraction document from a query and its hits. Defensive about the
 *  payload shape — web-search hits cross an event boundary as `unknown`. */
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

export const [webSearchIngestGraph] = createFunction(
  {
    id: "web.search.ingest-graph",
    retries: 1,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "web/search.completed" },
  async ({ event, step }) => {
    const { orgId, workspaceId, query, results } = event.data as {
      orgId: string;
      workspaceId: string;
      query?: unknown;
      results?: unknown;
    };

    const hits = Array.isArray(results) ? (results as SearchHit[]) : [];
    if (hits.length === 0) {
      return { ingested: 0, skipped: true };
    }

    const text = buildIngestText(typeof query === "string" ? query : "", hits);
    if (text.trim().length === 0) {
      return { ingested: 0, skipped: true };
    }
    const sourceUrl = hits
      .map((h) => (typeof h.url === "string" ? h.url : ""))
      .find((u) => u.length > 0);

    // Same runner context agent.execute-subagent uses for its child invokes, so
    // graph.ingest runs through the kernel with tenant scope, IAM, and metering.
    const ctx = {
      orgId,
      workspaceId,
      userId: null,
      apiKeyId: null,
      requestId: `web.search:${typeof query === "string" ? query : ""}`.slice(0, 200),
      surface: "runner" as const,
      messageId: null,
    };

    // A single extraction failure must surface in logs but never fail-loop the
    // function past its retry budget — the search itself already succeeded and
    // the row is the source of truth.
    const ok = await step.run("ingest", async () => {
      try {
        await runInTenantScope({ orgId, workspaceId }, () =>
          invoke("graph.ingest", { text, ...(sourceUrl ? { sourceUrl } : {}) }, ctx),
        );
        return true;
      } catch (err) {
        logger.warn(
          { err, orgId, query },
          "web.search.ingest-graph: graph.ingest failed for search",
        );
        return false;
      }
    });

    logger.info(
      { orgId, workspaceId, ingested: ok ? 1 : 0 },
      "web.search.ingest-graph: projected web-search results into the knowledge graph",
    );
    return { ingested: ok ? 1 : 0, skipped: false };
  },
);
