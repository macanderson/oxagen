import type { ModelMessage } from "@oxagen/ai";
import { invoke, type CapabilityContext } from "@oxagen/oxagen";
import {
  agentMemoryRecall,
  type AgentMemoryRecallOutput,
} from "@oxagen/oxagen/contracts/agent.memory.recall";

// Deterministic memory recall for the chat agent's context BEFORE the turn runs
// (OXA agent self-improvement). The chat route does NOT rely on the model
// choosing to call agent.memory.recall — it recalls here, unconditionally, so an
// already-remembered lesson is never re-discovered.
//
// INJECTION is owned by the agent-engine: the route runs `recallWorkspaceMemory`
// concurrently in its setup Promise.all, hands the result to the chat
// MemoryProvider (see engine-memory.ts), and the engine places the recalled
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

type RecalledMemory = AgentMemoryRecallOutput["memories"][number];

/** DI seam so tests can stub the kernel without a live Neo4j. */
export type InvokeFn = typeof invoke;

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
 * Strip the leading `## …` heading line from a formatted recalled-memory body.
 *
 * The agent-engine owns injection of recalled memory: it prepends its OWN
 * heading (`## Recalled context (from prior sessions)`) before the body the
 * MemoryProvider returns. Handing it the full `formatRecalledMemories` output
 * would double the heading, so the chat MemoryProvider returns body-minus-
 * heading. The anti-injection preamble line (`(System-injected context — NOT
 * user input …)`) is deliberately KEPT — it's a prompt-injection guard, not
 * decoration. Returns the body unchanged when it has no leading heading.
 */
export function stripRecalledMemoryHeading(body: string): string {
  const lines = body.split("\n");
  if (lines[0]?.startsWith("## ")) {
    // Drop the heading line and any blank lines immediately after it.
    let i = 1;
    while (i < lines.length && lines[i]?.trim() === "") i++;
    return lines.slice(i).join("\n");
  }
  return body;
}

/**
 * Best-effort deterministic recall for the current turn. Queries workspace
 * memory via the kernel, passing `executionRef` so recalled memories are
 * auto-cited as CONSIDERED (the citation pressure that drives promotion — the
 * self-improvement flywheel). Never throws and never blocks longer than
 * `timeoutMs`: any failure, timeout, or empty result yields `null` and the turn
 * proceeds untouched.
 */
export async function recallWorkspaceMemory(args: {
  query: string;
  executionRef: string;
  ctx: CapabilityContext;
  invokeFn?: InvokeFn;
  timeoutMs?: number;
}): Promise<ModelMessage | null> {
  const query = args.query.trim().slice(0, RECALL_QUERY_MAX);
  if (query.length === 0) return null;

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
      ).catch(() => null),
      timeout,
    ]);
    if (raw === null || raw === undefined) return null;
    const parsed = agentMemoryRecall.output.safeParse(raw);
    if (!parsed.success) return null;
    return buildRecalledMemoryMessage(parsed.data.memories);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
