import type { ModelMessage } from "ai";
import { invoke, type CapabilityContext } from "@oxagen/oxagen";
import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import type { MemoryProvider } from "@oxagen/agent-engine";

// Deterministic per-turn memory recall for the REST chat + A2A agent surfaces.
//
// This mirrors the app-chat surface's recall wiring (ADR-021 §2/§8):
// recall workspace memory BEFORE the turn acts, via the metered, IAM-gated
// `agent.memory.recall` capability (never a raw Neo4j call), and inject the
// result per-turn AFTER the stable/cached system prefix — never into the cached
// system block. The agent-engine owns injection: it places the recalled block as
// a volatile USER message between history and the instruction, so recalled
// memory (which changes every turn) never busts the Anthropic prompt-cache
// breakpoint on the stable system prefix (packages/agent-engine/src/engine.ts).
//
// Unlike the app surface this omits UI citation resolution — the REST/A2A wire
// formats carry no "Grounded in" citation strip — but the recall query itself is
// identical, including `executionRef` so recalled memories are auto-cited as
// CONSIDERED (the promotion / self-improvement flywheel).

// How many memories to pull. Small — enough to seed context without bloating the
// prompt or slowing the recall query. Matches the app-chat surface.
const RECALL_LIMIT = 6;

// The user text drives the semantic recall query; cap it so a huge paste doesn't
// dominate the embedding or the recall latency.
const RECALL_QUERY_MAX = 500;

// Hard ceiling on how long recall may delay the start of the turn. Neo4j recall
// is best-effort context enrichment — a slow or down graph must never stall the
// turn, so we race the invoke against this timeout and inject nothing on expiry.
const RECALL_TIMEOUT_MS = 2500;

type RecalledMemory = ReturnType<
  typeof agentMemoryRecall.output.parse
>["memories"][number];

/** DI seam so tests can stub the kernel without a live Neo4j. */
export type InvokeFn = typeof invoke;

/**
 * Render recalled memories into the volatile-message body, or `null` when there
 * is nothing to inject. The block leads with an anti-injection preamble so the
 * model treats these as authoritative system-injected context, not user input.
 * Mirrors the app-chat surface's `formatRecalledMemories`.
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
 * Strip the leading `## …` heading line from a formatted recalled-memory body.
 * The agent-engine prepends its OWN heading (`## Recalled context (from prior
 * sessions)`) before the body the MemoryProvider returns, so handing it the full
 * `formatRecalledMemories` output would double the heading. The anti-injection
 * preamble line is deliberately KEPT — it is a prompt-injection guard.
 */
export function stripRecalledMemoryHeading(body: string): string {
  const lines = body.split("\n");
  if (lines[0]?.startsWith("## ")) {
    let i = 1;
    while (i < lines.length && lines[i]?.trim() === "") i++;
    return lines.slice(i).join("\n");
  }
  return body;
}

/**
 * Best-effort deterministic recall for the current turn. Queries workspace
 * memory via the kernel, passing `executionRef` so recalled memories are
 * auto-cited as CONSIDERED. Never throws and never blocks longer than
 * `timeoutMs`: any failure, timeout, or empty result yields `null` and the turn
 * proceeds with no recalled context. MUST be called inside an active tenant
 * scope (the invoke reads workspace-scoped memory).
 */
export async function recallWorkspaceMemoryMessage(args: {
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
        // Recall runs on behalf of the chat agent — mark it the `agent` surface
        // (matching the other agent-capability invokes) so IAM and metering
        // attribute it correctly. agent.memory.recall exposes no api/mcp surface.
        { surface: "agent" },
      ).catch(() => null),
      timeout,
    ]);
    if (raw === null || raw === undefined) return null;
    const parsed = agentMemoryRecall.output.safeParse(raw);
    if (!parsed.success) return null;
    const body = formatRecalledMemories(parsed.data.memories);
    if (body === null) return null;
    return { role: "user", content: body };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * MemoryProvider for the agent-engine over an already-started recall promise.
 *
 * The engine calls `recallContext()` sequentially at turn start. To avoid adding
 * recall's time-boxed latency BEFORE the first model token, the caller keeps
 * `recallWorkspaceMemoryMessage(...)` running CONCURRENTLY with tool
 * materialization / prompt config inside its existing `Promise.all`, and hands
 * the already-started promise here. `recallContext()` just awaits it. The engine
 * prepends its own `## Recalled context …` heading, so this returns the body
 * with that leading heading stripped (the anti-injection preamble is kept).
 *
 * `remember` is a no-op: chat memory writes happen through the metered,
 * IAM-gated `agent.memory.record` capability the model can call — not the
 * engine's terminal `remember("coding_turn", …)`, which is a CLI/filesystem
 * episodic-store convention.
 */
export function createRecalledMemoryProvider(args: {
  recalledPromise: Promise<ModelMessage | null>;
}): MemoryProvider {
  return {
    async recallContext(): Promise<string> {
      const msg = await args.recalledPromise;
      if (msg === null) return "";
      const body = typeof msg.content === "string" ? msg.content : "";
      return stripRecalledMemoryHeading(body);
    },
    remember(): void {
      // Intentional no-op — see the doc comment.
    },
  };
}
