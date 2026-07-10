/**
 * Engram runtime bootstrap — wires the async graph-sync client and the
 * compile-telemetry sink into the @oxagen/engram module singletons.
 *
 * @oxagen/engram is deliberately provider-agnostic: `graph/emit-sync.ts` and
 * `compiler/telemetry.ts` each hold a module-level slot (setGraphSyncClient /
 * setCompileTelemetrySink) that stays `null` — so every emit silently no-ops —
 * until a surface injects the concrete backend here at boot. Without this call
 * new Engram memories never get their :REMEMBERS/:ABOUT Neo4j edges or
 * embeddings, and compile() telemetry is dropped on the floor.
 *
 * Call once per server surface that dispatches agent capabilities (apps/api,
 * apps/app), right after the other bootstrap*Runtime() calls.
 *
 * - Graph sync: the surface's Inngest EventClient (structurally a
 *   GraphSyncEventClient) so emitGraphSync/emitEmbedEvent fire the
 *   `engram/memory.graph-sync` / `engram/memory.embed` events that the
 *   engram.sync-memory-to-graph / engram.embed-memory functions consume.
 * - Compile telemetry: a ClickHouse-backed sink that appends one row per
 *   compile() to the shared append-only `events` stream (event_type
 *   `engram.compile`) via the canonical insertEvents() helper — no bespoke
 *   table, per the four-store data model.
 *
 * Both paths are best-effort: emitGraphSync/emitEmbedEvent and
 * emitCompileTelemetry swallow their own errors, so a degraded Inngest or
 * ClickHouse never breaks the agent's critical path.
 */
import {
  setGraphSyncClient,
  setCompileTelemetrySink,
  type GraphSyncEventClient,
  type CompileTelemetryEvent,
} from "@oxagen/engram";
import { insertEvents } from "@oxagen/telemetry";

/**
 * ClickHouse sink for engram compile telemetry. Maps the compile event onto
 * the append-only `events` stream. Called from emitCompileTelemetry, which
 * awaits then swallows any throw — so a ClickHouse hiccup degrades to a dropped
 * telemetry row, never a failed compile.
 */
async function insertCompileTelemetry(
  event: CompileTelemetryEvent,
): Promise<void> {
  await insertEvents([
    {
      event_id: event.compile_id,
      org_id: event.org_id,
      workspace_id: event.workspace_id,
      event_type: "engram.compile",
      source_system: "engram",
      stream_offset: null,
      // Full compile telemetry (latency breakdown, budget utilisation,
      // cache-hit rate, per-engine candidate counts) rides in the payload; a
      // new metric never needs a migration.
      payload: JSON.stringify(event),
      emitted_at: event.created_at,
    },
  ]);
}

/**
 * Wire the Engram async backends for this surface. Idempotent — safe to call
 * again on a dev hot-reload (the setters just overwrite the module slot).
 *
 * @param eventClient the surface's durable-function EventClient (from
 *   `@oxagen/inngest-functions/adapter`), passed in so @oxagen/agent never has
 *   to depend on the Inngest package — which itself depends on @oxagen/agent
 *   (that would be a dependency cycle).
 */
export function bootstrapEngramRuntime(
  eventClient: GraphSyncEventClient,
): void {
  setGraphSyncClient(eventClient);
  setCompileTelemetrySink(insertCompileTelemetry);
}
