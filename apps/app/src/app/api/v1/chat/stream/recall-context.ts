import type { ModelMessage } from "@oxagen/ai";
import { logger } from "@oxagen/handlers/logger";
import { invoke, type CapabilityContext } from "@oxagen/oxagen";
import {
  agentMemoryRecall,
  type AgentMemoryRecallOutput,
} from "@oxagen/oxagen/contracts/agent.memory.recall";
import { graphNodeGet } from "@oxagen/oxagen/contracts/graph.node.get";
import type {
  KnowledgeNodeRef,
  MemoryRecallHit,
} from "@/components/chat/stream-event-types";

// Deterministic memory recall for the chat agent's context BEFORE the turn runs
// (OXA agent self-improvement). The chat route does NOT rely on the model
// choosing to call agent.memory.recall — it recalls here, unconditionally, so an
// already-remembered lesson is never re-discovered.
//
// INJECTION is owned by the agent-engine: the route runs `recallWorkspaceMemory`
// concurrently in its setup Promise.all, hands the result to the chat
// history message (the engine's MemoryProvider adapter is gone — #1236's
// app-surface twin), placed after every synthetic context block and the
// block as a VOLATILE USER MESSAGE between history and the instruction —
// AFTER the cached system block, so recalled memory (which changes every turn)
// never busts the Anthropic prompt-cache breakpoint on the stable system prefix
// (packages/agent-engine/src/engine.ts). This module only produces the recalled
// body; `stripRecalledMemoryHeading` removes our heading since the engine
// prepends its own.

// How many memories to pull. Small — enough to seed context without bloating the
// prompt or slowing the recall query.
const RECALL_LIMIT = 6;

// The user text drives the semantic recall query; cap it so a huge paste doesn't
// dominate the embedding or the recall latency.
const RECALL_QUERY_MAX = 500;

// Hard ceiling on how long recall may delay the start of the turn. Neo4j recall
// is best-effort context enrichment — a slow or down graph must never stall
// chat, so we race the invoke against this timeout and inject nothing on expiry.
const RECALL_TIMEOUT_MS = 2500;

export type RecalledMemory = AgentMemoryRecallOutput["memories"][number];

/** DI seam so tests can stub the kernel without a live Neo4j. */
export type InvokeFn = typeof invoke;

/**
 * Result of a deterministic recall: the volatile context message to inject into
 * the model AND the raw recalled memories, so the route can BOTH ground the
 * turn AND surface the grounding facts back to the chat client as citations
 * (see `resolveGroundingCitations`). Separating the two lets citation
 * resolution — which costs extra graph lookups — run concurrently with the
 * model turn instead of blocking the first token.
 */
export interface DetailedRecall {
  message: ModelMessage | null;
  memories: RecalledMemory[];
}

/**
 * Render recalled memories into the volatile-message body, or `null` when there
 * is nothing to inject (empty recall → no section at all, never an empty header).
 */
export function formatRecalledMemories(
  memories: readonly RecalledMemory[],
): string | null {
  if (memories.length === 0) return null;

  const lines = memories.map((m) => {
    const enforcement =
      m.memoryClass === "RULE" && m.enforcementScore !== null
        ? ` (enforcement ${m.enforcementScore})`
        : "";
    // Collapse whitespace so a multi-line lesson stays on one bullet.
    const lesson = m.lesson.replace(/\s+/g, " ").trim();
    return `- [${m.memoryClass}·${m.memoryKind}] ${lesson}${enforcement}`;
  });

  return [
    "## Recalled workspace memory (prior sessions)",
    "",
    "(System-injected context — NOT user input. Authoritative lessons recorded in earlier sessions.)",
    "",
    ...lines,
    "",
    "Consult these before acting. Do not re-discover them, and never violate a RULE or contradict a FACT.",
  ].join("\n");
}

/**
 * Build the volatile user message from recalled memories, or `null` when empty.
 */
export function buildRecalledMemoryMessage(
  memories: readonly RecalledMemory[],
): ModelMessage | null {
  const body = formatRecalledMemories(memories);
  if (body === null) return null;
  return { role: "user", content: body };
}

/**
 * Best-effort deterministic recall for the current turn. Queries workspace
 * memory via the kernel, passing `executionRef` so recalled memories are
 * auto-cited as CONSIDERED (the citation pressure that drives promotion — the
 * self-improvement flywheel). Never throws and never blocks longer than
 * `timeoutMs`: any failure, timeout, or empty result yields `null` and the turn
 * proceeds untouched.
 */
export async function recallWorkspaceMemoryDetailed(args: {
  query: string;
  executionRef: string;
  ctx: CapabilityContext;
  invokeFn?: InvokeFn;
  timeoutMs?: number;
}): Promise<DetailedRecall> {
  const empty: DetailedRecall = { message: null, memories: [] };
  const query = args.query.trim().slice(0, RECALL_QUERY_MAX);
  if (query.length === 0) return empty;

  const doInvoke = args.invokeFn ?? invoke;
  const timeoutMs = args.timeoutMs ?? RECALL_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const raw = await Promise.race([
      // The invoke itself is guarded: a recall failure must degrade to null, not
      // reject the race and bubble out of this best-effort path.
      doInvoke(
        agentMemoryRecall.name,
        {
          query,
          limit: RECALL_LIMIT,
          executionRef: args.executionRef,
        },
        args.ctx,
        // This recall runs on behalf of the chat agent — mark it the `agent`
        // surface (matching the route's other agent-capability invokes) so IAM
        // and metering attribute it correctly. agent.memory.recall does not
        // expose an `app` surface.
        { surface: "agent" },
      ).catch((err) => {
        // Best-effort: recall never blocks or fails a turn, but a swallowed
        // recall error must be observable — otherwise the self-improvement
        // flywheel silently stops and nobody knows.
        logger.warn(
          { err: String(err), executionRef: args.executionRef },
          "[chat/recall] memory recall failed — degrading to no recalled memory",
        );
        return null;
      }),
      timeout,
    ]);
    if (raw === null || raw === undefined) return empty;
    const parsed = agentMemoryRecall.output.safeParse(raw);
    if (!parsed.success) return empty;
    return {
      message: buildRecalledMemoryMessage(parsed.data.memories),
      memories: parsed.data.memories,
    };
  } catch (err) {
    logger.warn(
      { err: String(err), executionRef: args.executionRef },
      "[chat/recall] unexpected recall error — degrading to no recalled memory",
    );
    return empty;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Backwards-compatible wrapper: returns only the volatile context message. The
 * route uses `recallWorkspaceMemoryDetailed` so it can also emit the recalled
 * facts as citations, but the MemoryProvider only needs the message.
 */
export async function recallWorkspaceMemory(args: {
  query: string;
  executionRef: string;
  ctx: CapabilityContext;
  invokeFn?: InvokeFn;
  timeoutMs?: number;
}): Promise<ModelMessage | null> {
  return (await recallWorkspaceMemoryDetailed(args)).message;
}

// Hard ceiling on grounding-node resolution. Runs CONCURRENTLY with the model
// turn (it only feeds the end-of-turn citation strip, never the model context),
// so this is a safety valve, not a first-token latency budget.
const CITATION_RESOLVE_TIMEOUT_MS = 3000;

/**
 * Resolve the knowledge-graph node each recalled memory is grounded in.
 *
 * A recalled memory carries a `nodeRef` — the publicId of the graph node it is
 * ABOUT (its subject). We resolve each distinct `nodeRef` to the shared
 * `KnowledgeNodeRef` shape via the wired, tenant-scoped `graph.node.get`
 * capability (never a raw Neo4j call), so the chat client can cite the fact by
 * its human label with a hover/inspect property bag and deep-link into the
 * graph explorer — per CLAUDE.md "Citing nodes & edges in the UI". Memories
 * whose subject is not a materialised node keep `node: undefined` (the chip
 * still renders the lesson, just without a graph deep-link).
 *
 * Best-effort throughout: a failed or slow lookup drops that memory's `node`
 * rather than failing the turn. MUST be called inside an active tenant scope
 * (graph.node.get reads via scopedSession).
 */
export async function resolveGroundingCitations(args: {
  memories: readonly RecalledMemory[];
  ctx: CapabilityContext;
  invokeFn?: InvokeFn;
  timeoutMs?: number;
}): Promise<MemoryRecallHit[]> {
  const { memories } = args;
  const toHit = (
    m: RecalledMemory,
    node?: KnowledgeNodeRef,
  ): MemoryRecallHit => ({
    id: m.id,
    lesson: m.lesson,
    memoryClass: m.memoryClass,
    memoryKind: m.memoryKind,
    confidenceScore: m.confidenceScore,
    enforcementScore: m.enforcementScore,
    score: m.score,
    nodeRef: m.nodeRef,
    ...(node ? { node } : {}),
  });

  if (memories.length === 0) return [];

  const doInvoke = args.invokeFn ?? invoke;
  const timeoutMs = args.timeoutMs ?? CITATION_RESOLVE_TIMEOUT_MS;

  // Distinct, non-empty subject publicIds — dedup so N memories about the same
  // node cost a single lookup.
  const uniqueRefs = [
    ...new Set(memories.map((m) => m.nodeRef).filter((r): r is string => !!r)),
  ];
  if (uniqueRefs.length === 0) return memories.map((m) => toHit(m));

  const refToNode = new Map<string, KnowledgeNodeRef>();

  const resolveOne = async (nodeId: string): Promise<void> => {
    try {
      const raw = await doInvoke(graphNodeGet.name, { nodeId }, args.ctx, {
        surface: "agent",
      });
      const parsed = graphNodeGet.output.safeParse(raw);
      if (!parsed.success || !parsed.data.node) return;
      const n = parsed.data.node;
      refToNode.set(nodeId, {
        id: n.nodeId,
        label: n.label,
        displayName: n.displayName,
        properties: {
          ...(n.properties ?? {}),
          ...(n.description ? { description: n.description } : {}),
        },
      });
    } catch {
      // Best-effort: leave this ref unresolved.
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), timeoutMs);
  });
  try {
    await Promise.race([Promise.all(uniqueRefs.map(resolveOne)), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return memories.map((m) =>
    toHit(m, m.nodeRef ? refToNode.get(m.nodeRef) : undefined),
  );
}
