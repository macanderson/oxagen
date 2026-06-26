/**
 * Context compiler integration — replaces ad-hoc context assembly with
 * engram.compile() for every agent turn.
 *
 * Always-on. No feature flags. If compile() fails for any reason,
 * falls back to legacy context so the agent loop never breaks.
 */
import type { ContextWindow } from "@oxagen/engram";
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
    const { compile, computeBudget, createStore, TemporalRetrievalEngine } = await import(
      "@oxagen/engram"
    );

    const taskFrame = buildTaskFrame(ctx, messages);
    const budget = computeBudget(taskFrame.modelId);
    const store = createStore();

    // Start with temporal retrieval (always available, no external deps).
    // Vector, graph, and lexical engines are added as they become operational.
    const engines = [new TemporalRetrievalEngine(store)];

    const window = await compile(taskFrame, budget, {
      engines,
      store,
      systemPrompt: "",
      candidatesPerEngine: 20,
      diversityConstraint: 3,
    });

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
