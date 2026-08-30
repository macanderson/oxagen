/**
 * `MemoryProvider` adapter — bridges the CLI's memory stores to the engine's
 * single {@link MemoryProvider} port.
 *
 * The CLI has three complementary stores:
 *   - {@link SessionMemory} — the engram/DuckDB episodic store (best-effort,
 *     silently disabled when its native dep is missing). Source of the session
 *     tail in `recallContext`.
 *   - {@link FleetMemory} — a guaranteed JSON-lines weighted-lesson store, read by
 *     the agents-screen memory panel and future offline runs.
 *   - {@link ServerMemory} — the PLATFORM two-axis AgentMemory store (Neo4j),
 *     reached over the /v1 API. Only present when the CLI is authenticated; it is
 *     what lets a lesson learned in one session steer a task in another. Every
 *     server call is best-effort: `remember` is fire-and-forget (never awaited),
 *     and `recall` is wall-clock bounded by {@link createCombinedMemory}
 *     ({@link DEFAULT_SERVER_TIMEOUT_MS}) so an unreachable API never stalls a
 *     run. A caller that holds a bare {@link ServerMemory} and awaits `recall`
 *     directly gets no such bound — go through the combined provider.
 *
 * `recallContext` returns the session tail followed by the semantically relevant
 * workspace memories. `remember` writes to the session store always, mirrors the
 * two-axis lesson kinds into the fleet store, and — for the high-signal lesson
 * kinds only — mirrors them to the platform so recall in later sessions can match
 * them. Noisy episodic kinds (user_prompt / tool_call / assistant_reply /
 * coding_turn) are never sent to the platform.
 */
import type { MemoryProvider } from "@oxagen/agent-engine";
import type { SessionMemory, Outcome } from "../memory.js";
import type { FleetMemory, MemoryRecord } from "../fleet/memory.js";
import {
  recallMemories,
  rememberMemory,
  type RecalledMemory,
} from "../../lib/memory-client.js";
import { debugLog } from "../../lib/debug-log.js";

/** Kinds the engine records that we mirror into the fleet two-axis lesson store. */
const FLEET_KINDS = new Set<MemoryRecord["memoryKind"]>([
  "gotcha",
  "routine-change",
  "bug-root-cause",
]);

/**
 * High-signal lesson kinds mirrored to the PLATFORM memory store. A superset of
 * {@link FLEET_KINDS} (adds `convention-deviation`); the noisy per-turn episodic
 * kinds are deliberately excluded so the workspace graph stays a store of durable
 * lessons, not a transcript.
 */
const SERVER_LESSON_KINDS = new Set<string>([
  "gotcha",
  "bug-root-cause",
  "routine-change",
  "convention-deviation",
]);

/** Default ceiling on any single server call so an unreachable API can't stall a run. */
const DEFAULT_SERVER_TIMEOUT_MS = 3000;

/** True when memory is disabled for this run (benchmark isolation). */
function memoryDisabled(): boolean {
  return process.env["OXAGEN_DISABLE_MEMORY"] === "1";
}

/** Coerce an arbitrary status string into the session store's {@link Outcome}. */
function toOutcome(status: string | undefined): Outcome {
  return status === "success" || status === "failure" ? status : "unknown";
}

/**
 * The platform-memory half of the combined provider — the only part that talks
 * to the /v1 API. Injected (rather than constructed here) so the adapter stays
 * free of transport/config coupling and is trivially fakeable in tests.
 */
export interface ServerMemory {
  /** Recall workspace memories semantically relevant to `query`. Best-effort. */
  recall(query: string): Promise<RecalledMemory[]>;
  /** Mirror a high-signal lesson to the platform. Fire-and-forget. */
  remember(kind: string, content: unknown): void;
}

export interface ServerMemoryOptions {
  /** Agent id stamped on the auto-recorded execution during recall. */
  agentId?: string;
  /**
   * Stable per-run ref (e.g. `cli:<sessionId>`) that groups this run's recall
   * citations under one :Execution — the citation pressure that drives promotion.
   */
  executionRef?: string;
  /** Project/repo name (from cwd) prefixed onto mirrored lessons for later recall matching. */
  projectName?: string;
  /** How many memories to recall per task. */
  recallLimit?: number;
}

/** Pull a human lesson string out of the engine's `remember` content payload. */
function lessonText(content: unknown): string {
  if (typeof content === "string") return content;
  const c = (content ?? {}) as { lesson?: string };
  return typeof c.lesson === "string" ? c.lesson : JSON.stringify(content);
}

/** Pull the touched-files list out of the engine's `remember` content payload. */
function contentFiles(content: unknown): string[] {
  const c = (content ?? {}) as { files?: unknown };
  return Array.isArray(c.files)
    ? c.files.filter((f): f is string => typeof f === "string")
    : [];
}

/**
 * Build the real platform-memory handle from the typed memory client. Recall
 * auto-cites via `executionRef`; remember enriches the lesson with project +
 * touched-files context so recall in another session can match it, then fires
 * without awaiting (errors swallowed — memory must never break a run).
 */
export function createServerMemory(
  opts: ServerMemoryOptions = {},
): ServerMemory {
  return {
    async recall(query) {
      // Guard the kill switch here too, not only in the combined provider: a
      // caller holding a bare ServerMemory must not reach the API either.
      if (memoryDisabled()) return [];
      const res = await recallMemories({
        query,
        limit: opts.recallLimit ?? 6,
        executionRef: opts.executionRef,
        agentId: opts.agentId,
      });
      return res.memories;
    },

    remember(kind, content) {
      // The fleet orchestrator mirrors lessons through this handle directly
      // (orchestrator.ts's `serverMemory?.remember`), so the kill switch has to
      // be checked here as well as in the combined provider.
      if (memoryDisabled()) return;
      const lesson = lessonText(content);
      if (!lesson.trim()) return;
      const files = contentFiles(content);
      const prefix = opts.projectName ? `[${opts.projectName}] ` : "";
      const filesSuffix = files.length
        ? ` (files: ${files.slice(0, 5).join(", ")})`
        : "";
      const text = `${prefix}${lesson}${filesSuffix}`;
      void rememberMemory({ text, memoryKind: kind, source: "fix" }).catch(
        (err: unknown) => {
          // Fire-and-forget: a failed mirror must never break a run, but it is
          // no longer silent — record it on the CLI debug channel.
          void debugLog("error", "memory.remember-failed", {
            message: err instanceof Error ? err.message : String(err),
          });
        },
      );
    },
  };
}

/** Class ordering for the recalled-lessons block — enforceable memories first. */
function classRank(m: RecalledMemory): number {
  return m.memoryClass === "FACT" ? 0 : m.memoryClass === "RULE" ? 1 : 2;
}

/**
 * Render recalled platform memories as a distinct prompt section. RULE/FACT
 * memories (previously-discovered issues the agent must respect) sort ahead of
 * OBSERVATIONs. Returns "" when there is nothing to show.
 */
export function formatServerMemories(memories: RecalledMemory[]): string {
  const seen = new Set<string>();
  const rows = memories
    .slice()
    .sort(
      (a, b) =>
        classRank(a) - classRank(b) || b.confidenceScore - a.confidenceScore,
    )
    .filter((m) => {
      const key = m.lesson.replace(/\s+/g, " ").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(
      (m) =>
        `- [${m.memoryClass}/${m.memoryKind}] ${m.lesson} (confidence ${Math.round(m.confidenceScore)})`,
    );
  if (rows.length === 0) return "";
  return (
    "## Lessons from prior sessions (workspace memory)\n" + rows.join("\n")
  );
}

/** Resolve `p` but reject once `ms` elapses, so a hung API call can't stall a run. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server memory timeout")),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface CombinedMemoryOptions {
  /** Platform memory handle; omit (or null) to run local-only, e.g. when not logged in. */
  server?: ServerMemory | null;
  /** The task instruction to recall against — required for any server recall. */
  recallQuery?: string;
  /** Override the per-server-call timeout (ms). */
  serverTimeoutMs?: number;
}

/**
 * Combine the episodic session store, the weighted fleet store, and (when
 * authenticated) the platform memory store into one {@link MemoryProvider} the
 * engine can inject. Any store may be absent; the adapter degrades to whatever
 * is present, and every platform call is best-effort so an offline/unreachable
 * API is indistinguishable from "no server store" to the caller.
 */
export function createCombinedMemory(
  session: SessionMemory | null,
  fleet: FleetMemory | null,
  options: CombinedMemoryOptions = {},
): MemoryProvider {
  const { server, recallQuery } = options;
  const serverTimeoutMs = options.serverTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;
  const serverEnabled = !!server && !memoryDisabled();

  async function recallServer(): Promise<string> {
    if (!serverEnabled || !server || !recallQuery?.trim()) return "";
    try {
      const memories = await withTimeout(
        server.recall(recallQuery),
        serverTimeoutMs,
      );
      return formatServerMemories(memories);
    } catch {
      // Best-effort: an unreachable/slow API degrades to local-only, never fatal.
      return "";
    }
  }

  return {
    async recallContext() {
      const local = session
        ? await session.recallContext().catch((err: unknown) => {
            // Best-effort: an episodic-store hiccup degrades to no session tail,
            // never fatal — but record it on the CLI debug channel.
            void debugLog("error", "memory.recall-failed", {
              message: err instanceof Error ? err.message : String(err),
            });
            return "";
          })
        : "";
      const remote = await recallServer();
      return [local, remote].filter((s) => s).join("\n\n");
    },

    remember(kind, content, status) {
      // Episodic write (best-effort; the store swallows its own errors but guard
      // the call itself so a thrown rejection can never escape the turn).
      void Promise.resolve(
        session?.remember(kind, content, toOutcome(status)),
      ).catch(() => {});

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

      // Mirror only the high-signal lesson kinds to the platform (fire-and-forget).
      if (serverEnabled && server && SERVER_LESSON_KINDS.has(kind)) {
        server.remember(kind, content);
      }
    },

    close: session ? () => session.close() : undefined,
  };
}
