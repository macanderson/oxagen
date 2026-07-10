/**
 * Context compiler integration — replaces ad-hoc context assembly with
 * engram.compile() for every agent turn.
 *
 * Always-on. No feature flags. If compile() fails for any reason,
 * falls back to legacy context so the agent loop never breaks.
 */
import type { ContextWindow, EmbedFn, VectorQueryFn, GraphQueryFn, LexicalSearchFn } from "@oxagen/engram";
import type { CapabilityContext } from "../types";
import { buildTaskFrame } from "./task-frame";

/**
 * Build agent context using the Engram context compiler.
 *
 * Returns the compiled context window as structured sections.
 * On any error, returns null (caller should use legacy context).
 */
export async function compileAgentContext(
  ctx: CapabilityContext,
  messages: Array<{ role: string; content: string }>,
): Promise<ContextWindow | null> {
  try {
    const {
      compile,
      computeBudget,
      createStore,
      TemporalRetrievalEngine,
      VectorRetrievalEngine,
      GraphRetrievalEngine,
      LexicalRetrievalEngine,
      emitCompileTelemetry,
    } = await import("@oxagen/engram");
    const { embedText } = await import("@oxagen/ai");
    const { scopedSession, oversampledLimit } = await import("@oxagen/ontology");
    const { runInTenantScope } = await import("@oxagen/tenancy");

    const taskFrame = buildTaskFrame(ctx, messages);
    const budget = computeBudget(taskFrame.modelId);
    const store = createStore();

    // Embed the task description through @oxagen/ai's metered embedText wrapper
    // (never call the `ai` package's embed() directly — every LLM/embedding
    // call must be metered via @oxagen/ai per this repo's law).
    const embedFn: EmbedFn = (text) =>
      embedText(text, {
        telemetry: {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          surface: ctx.surface,
          executionStepId: ctx.messageId ?? ctx.requestId,
        },
      });

    // Vector ANN recall over :EngramMemory.embedding (engram_memory_embedding_index).
    // Over-samples the index fetch (OXA-1929's oversampledLimit) so the tenant
    // filter below can't crowd this org/workspace's memories out of the global
    // top-K, then trims back to the requested limit.
    const vectorQuery: VectorQueryFn = (embedding, opts) =>
      runInTenantScope({ orgId: opts.orgId, workspaceId: opts.workspaceId }, async () => {
        const s = scopedSession();
        try {
          const result = await s.run(
            /* cypher */ `
              CALL db.index.vector.queryNodes('engram_memory_embedding_index', $k, $embedding)
              YIELD node AS m, score
              WHERE m.orgId = $orgId AND m.workspaceId = $workspaceId
              WITH m, score
              ORDER BY score DESC
              LIMIT $limit
              RETURN m.recordId AS recordId, score AS score
            `,
            {
              embedding,
              k: BigInt(oversampledLimit(opts.limit)),
              limit: BigInt(opts.limit),
            },
          );
          return result.records.map((r) => ({
            recordId: r.get("recordId") as string,
            score: Number(r.get("score")),
          }));
        } finally {
          await s.close();
        }
      });

    // Graph-structural recall — traverses :REMEMBERS/:ABOUT edges from the
    // task frame's working-set entity IDs. This is the actual moat retrieval
    // engine (docs/VISION.md graph-grounding). Runs through scopedSession(),
    // never a raw Neo4j driver call, so tenant scoping is enforced centrally.
    const graphQuery: GraphQueryFn = (cypher, params) =>
      runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
        const s = scopedSession();
        try {
          const result = await s.run(cypher, params);
          return result.records.map((r) => ({
            recordId: r.get("recordId") as string,
            salience: Number(r.get("salience")),
          }));
        } finally {
          await s.close();
        }
      });

    // Lexical/BM25-style exact-match recall (error messages, function names,
    // file paths, stack traces) via the episodic store's own full-text search.
    const lexicalSearch: LexicalSearchFn = (query, opts) =>
      store.searchLexical(
        { org: opts.orgId, workspace: opts.workspaceId },
        query,
        opts.limit,
      );

    const engines = [
      new TemporalRetrievalEngine(store),
      new VectorRetrievalEngine(store, embedFn, vectorQuery),
      new GraphRetrievalEngine(store, graphQuery),
      new LexicalRetrievalEngine(store, lexicalSearch),
    ];

    const window = await compile(taskFrame, budget, {
      engines,
      store,
      systemPrompt: "",
      candidatesPerEngine: 20,
      diversityConstraint: 3,
    });

    // Emit compile telemetry (latency breakdown, cache-hit rate, per-engine
    // candidate contribution, budget utilisation) to ClickHouse for the Phase D
    // fusion-weight dashboards. Fire-and-forget: emitCompileTelemetry swallows
    // sink errors internally so it never throws, and it is not awaited so the
    // ClickHouse round-trip stays off the compile path. No-ops until a surface
    // registers a sink via bootstrapEngramRuntime().
    void emitCompileTelemetry(taskFrame, window);

    return window;
  } catch {
    // Graceful degradation — compile() errors never break the agent loop.
    return null;
  }
}

/**
 * Convert a compiled context window into a system message string
 * suitable for injection into the LLM prompt.
 */
export function windowToSystemMessage(window: ContextWindow): string {
  return window.sections.map((s) => s.content).join("\n\n---\n\n");
}
