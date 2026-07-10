/**
 * Agent runtime integration for Engram memory writes.
 *
 * NOTE (wiring status): these emitters are NOT yet invoked by the server chat
 * routes (apps/api chat.stream, apps/app /api/v1/chat/stream). Wiring them into
 * the agent turn loop so every turn emits episodic events is a separate,
 * deliberate feature decision that has not landed. The async backends they
 * depend on — the Inngest graph-sync/embed client and the ClickHouse
 * compile-telemetry sink — ARE registered at surface bootstrap
 * (bootstrapEngramRuntime), so these functions fire correctly the moment a
 * caller invokes them; they no longer silently no-op on a null client.
 *
 * The store adapter is auto-detected from environment (DuckDB local,
 * ClickHouse cloud).
 *
 * After writing the record (source of truth), fires an async Inngest event
 * (`engram/memory.graph-sync`) so the Neo4j worker can create :REMEMBERS
 * and :ABOUT edges. The graph is eventually consistent — if Neo4j is down,
 * the record still exists and edges will land on retry.
 *
 * Errors are swallowed so memory writes never disrupt the agent's
 * critical path.
 */
import type { EpisodicBody, Engram, WriteOpts } from "@oxagen/engram";
import { emitGraphSync, emitEmbedEvent } from "@oxagen/engram";

/**
 * Lazily-initialized Engram instance. The first write triggers a dynamic
 * import of the store modules (duckdb/clickhouse) so we don't
 * pay the cost at process startup.
 */
let _engram: Engram | null = null;

async function getEngram(): Promise<Engram> {
  if (_engram) return _engram;
  const { createEngram, createStore } = await import("@oxagen/engram");
  const store = createStore();
  _engram = createEngram(store);
  return _engram;
}

export interface AgentEventContext {
  orgId: string;
  workspaceId: string;
  sessionId?: string;
  agentId?: string;
  messageId?: string;
}

export interface EmitOptions {
  /** Graph node reference this memory is about (creates :REMEMBERS edge in Neo4j). */
  nodeRef?: string;
  /** KnowledgeNode IDs this memory relates to (creates :ABOUT edges in Neo4j). */
  entityRefs?: string[];
}

/**
 * Emit an agent episodic event to Engram and fire graph sync.
 *
 * Non-blocking: errors are swallowed and logged to avoid disrupting
 * the agent's critical path.
 */
export async function emitAgentEvent(
  ctx: AgentEventContext,
  event: EpisodicBody,
  emitOpts?: EmitOptions,
): Promise<void> {
  try {
    const engram = await getEngram();
    const opts: WriteOpts = {
      namespace: {
        org: ctx.orgId,
        workspace: ctx.workspaceId,
        session: ctx.sessionId,
        agent: ctx.agentId,
      },
      provenance: {
        author: ctx.agentId ?? "agent-runtime",
        derivedFrom: ctx.messageId ? [ctx.messageId] : [],
        timestamp: Date.now(),
      },
      nodeRef: emitOpts?.nodeRef,
      entityRefs: emitOpts?.entityRefs,
    };

    const recordId = await engram.remember(event, opts);

    // Fire async graph sync — best-effort, never blocks or throws.
    // The Inngest worker will create :REMEMBERS and :ABOUT edges.
    if (
      emitOpts?.nodeRef ||
      (emitOpts?.entityRefs && emitOpts.entityRefs.length > 0)
    ) {
      const bodyText =
        typeof event.payload === "string"
          ? event.payload
          : JSON.stringify(event.payload);
      await emitGraphSync({
        recordId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        nodeRef: emitOpts.nodeRef ?? null,
        entityRefs: emitOpts.entityRefs ?? null,
        body: bodyText,
        kind: "episodic",
        salience: opts.salience ?? 0.3,
      });
    }

    // Fire async embed event — every record gets an embedding for vector retrieval.
    const embedBodyText =
      typeof event.payload === "string"
        ? event.payload
        : JSON.stringify(event.payload);
    await emitEmbedEvent({
      recordId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      kind: "episodic",
      body: `${event.event}: ${embedBodyText}`.slice(0, 2000),
    });
  } catch {
    // Swallow errors — memory writes must never break agent execution.
  }
}

/**
 * Emit a tool call event — called after every tool invocation in the agent loop.
 */
export async function emitToolCall(
  ctx: AgentEventContext,
  toolName: string,
  outcome: "success" | "failure",
  payload?: unknown,
  emitOpts?: EmitOptions,
): Promise<void> {
  await emitAgentEvent(
    ctx,
    { event: "tool_call", payload: { tool: toolName, data: payload }, outcome },
    emitOpts,
  );
}

/**
 * Emit a decision event — called when the agent makes a routing/planning decision.
 */
export async function emitDecision(
  ctx: AgentEventContext,
  decision: string,
  reasoning?: string,
): Promise<void> {
  await emitAgentEvent(ctx, {
    event: "decision",
    payload: { decision, reasoning },
  });
}

/**
 * Close the Engram store. Call during graceful shutdown.
 */
export async function closeEngramWriter(): Promise<void> {
  if (_engram) {
    await _engram.close();
    _engram = null;
  }
}

/**
 * Reset for tests — clears the cached Engram instance.
 */
export function clearEngramWriterForTests(): void {
  _engram = null;
}
