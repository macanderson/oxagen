import type { ModelMessage } from "@oxagen/ai";
import type { MemoryProvider } from "@oxagen/agent-engine";
import { stripRecalledMemoryHeading } from "./recall-context";

/**
 * Chat-surface MemoryProvider for the agent-engine.
 *
 * The engine calls `recallContext()` sequentially at turn start. To avoid
 * adding the recall's time-boxed latency (up to RECALL_TIMEOUT_MS ≈ 2.5s)
 * BEFORE the first model token, the route keeps `recallWorkspaceMemory(...)`
 * running CONCURRENTLY with tool materialization / prompt config / skills
 * inside its existing `Promise.all` (as it always did), and hands the
 * already-started promise here. `recallContext()` just awaits it — recall runs
 * in parallel with the rest of turn setup, not serially in front of it (C3).
 *
 * `recallWorkspaceMemory` resolves to a `ModelMessage | null` whose content is
 * the full `formatRecalledMemories` body (heading + anti-injection preamble +
 * bullets). The engine prepends its own `## Recalled context …` heading, so we
 * return the body with that leading heading stripped (the preamble is kept —
 * see `stripRecalledMemoryHeading`).
 *
 * `remember` is a no-op: chat memory writes happen through the metered,
 * IAM-gated `agent.memory.record` capability tool the model can call — not the
 * engine's terminal `remember("coding_turn", …)`, which is a CLI/filesystem
 * episodic-store convention.
 */
export function createChatMemoryProvider(args: {
  /** The recall promise kicked off in the route's setup Promise.all (already running). */
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
