/**
 * `MemoryProvider` adapter — bridges the CLI's two local memory stores to the
 * engine's single {@link MemoryProvider} port.
 *
 * The CLI has two complementary stores:
 *   - {@link SessionMemory} — the engram/DuckDB episodic store (best-effort,
 *     silently disabled when its native dep is missing). Source of `recallContext`.
 *   - {@link FleetMemory} — a guaranteed JSON-lines weighted-lesson store, read by
 *     the agents-screen memory panel and future offline runs.
 *
 * `recallContext` reads recent project activity from the session store. `remember`
 * writes to the session store always, and *mirrors* the two-axis lesson kinds
 * (gotcha / routine-change / bug-root-cause) into the fleet store so a lesson the
 * engine records this turn survives for later sessions even when DuckDB is absent.
 */
import type { MemoryProvider } from "@oxagen/agent-engine";
import type { SessionMemory, Outcome } from "../memory.js";
import type { FleetMemory, MemoryRecord } from "../fleet/memory.js";

/** Kinds the engine records that we mirror into the fleet two-axis lesson store. */
const FLEET_KINDS = new Set<MemoryRecord["memoryKind"]>([
  "gotcha",
  "routine-change",
  "bug-root-cause",
]);

/** Coerce an arbitrary status string into the session store's {@link Outcome}. */
function toOutcome(status: string | undefined): Outcome {
  return status === "success" || status === "failure" ? status : "unknown";
}

/**
 * Combine the episodic session store and the weighted fleet store into one
 * {@link MemoryProvider} the engine pipeline can inject. Either store may be null
 * (e.g. DuckDB unavailable); the adapter degrades to whatever is present.
 */
export function createCombinedMemory(
  session: SessionMemory | null,
  fleet: FleetMemory | null,
): MemoryProvider {
  return {
    async recallContext() {
      if (!session) return "";
      try {
        return await session.recallContext();
      } catch {
        return "";
      }
    },

    remember(kind, content, status) {
      // Episodic write (best-effort; the store swallows its own errors but guard
      // the call itself so a thrown rejection can never escape the turn).
      void Promise.resolve(session?.remember(kind, content, toOutcome(status))).catch(
        () => {},
      );

      // Mirror two-axis lesson kinds into the guaranteed fleet store.
      if (fleet && FLEET_KINDS.has(kind as MemoryRecord["memoryKind"])) {
        const payload = (content ?? {}) as {
          lesson?: string;
          files?: string[];
          outcome?: string;
        };
        fleet.record({
          memoryKind: kind as MemoryRecord["memoryKind"],
          memoryClass: kind === "gotcha" ? "RULE" : "OBSERVATION",
          enforcementScore: kind === "gotcha" ? 95 : null,
          lesson: payload.lesson ?? JSON.stringify(content),
          files: payload.files ?? [],
          outcome: payload.outcome === "failure" ? "failure" : "success",
        });
      }
    },

    close: session ? () => session.close() : undefined,
  };
}
