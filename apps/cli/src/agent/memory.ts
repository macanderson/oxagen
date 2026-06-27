/**
 * Session memory — the CLI's bridge to Oxagen's knowledge-graph-backed context
 * engine (`@oxagen/engram`).
 *
 * Each turn's activity is written as episodic records into a local content-
 * addressed store, scoped to the project (the working directory's name). At the
 * start of a turn we recall recent project activity and inject it as context, so
 * the agent remembers what it did in previous sessions on the same codebase.
 *
 * The store is best-effort: if it cannot be opened (e.g. the optional native
 * DuckDB dependency is unavailable in this environment), `openSessionMemory`
 * returns `null` and the agent loop runs without persistent memory rather than
 * failing. This keeps memory a strict enhancement, never a hard dependency.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createEngram, createStore, type EpisodicStore } from "@oxagen/engram";

export type Outcome = "success" | "failure" | "unknown";

export interface SessionMemory {
  /** Record an episodic event (best-effort; never throws). */
  remember(event: string, payload: unknown, outcome?: Outcome): Promise<void>;
  /** Recent project activity formatted for context injection (empty if none). */
  recallContext(limit?: number): Promise<string>;
  close(): Promise<void>;
}

function dbPath(): string {
  return join(homedir(), ".config", "oxagen", "context.duckdb");
}

/** Stable project key from the working directory name. */
function projectKey(cwd: string): string {
  return basename(cwd) || "default";
}

/**
 * Open the project's session memory. Returns `null` if the context store is
 * unavailable in this environment (the loop then runs memory-free).
 */
export async function openSessionMemory(
  cwd: string,
  sessionId: string,
): Promise<SessionMemory | null> {
  let store: EpisodicStore;
  try {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    store = createStore({ adapter: "duckdb", duckdbPath: path });
  } catch (err) {
    if (process.env["OXAGEN_DEBUG"])
      process.stderr.write(
        `[mem] open failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    return null;
  }

  const engram = createEngram(store);
  const workspace = projectKey(cwd);
  const namespace = { org: "local", workspace, session: sessionId };

  // Callers fire writes without awaiting (`void memory.remember(...)`), so we
  // track them here and flush on close — otherwise the process can exit before
  // DuckDB persists the append and the memory is silently lost.
  const pending = new Set<Promise<void>>();

  return {
    remember(event, payload, outcome) {
      const p = (async () => {
        try {
          await engram.remember(
            { event, payload, outcome },
            {
              namespace,
              provenance: {
                author: "oxagen-cli",
                derivedFrom: [],
                timestamp: Date.now(),
              },
            },
          );
        } catch {
          /* memory is best-effort */
        }
      })();
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },

    async recallContext(limit = 8) {
      try {
        // Recall across the whole project (not just this session) so the agent
        // carries knowledge between runs on the same codebase.
        const records = await store.recent({ org: "local", workspace }, limit);
        if (records.length === 0) return "";
        return records
          .reverse()
          .map((r) => {
            const b = r.body as {
              event: string;
              payload: unknown;
              outcome?: string;
            };
            const payloadStr =
              typeof b.payload === "string"
                ? b.payload
                : JSON.stringify(b.payload);
            const tail = b.outcome ? ` (${b.outcome})` : "";
            return `- [${b.event}] ${payloadStr.slice(0, 160)}${tail}`;
          })
          .join("\n");
      } catch {
        return "";
      }
    },

    async close() {
      // Flush any in-flight writes before closing, so nothing is lost on exit.
      await Promise.allSettled([...pending]);
      try {
        await store.close();
      } catch {
        /* already closed */
      }
    },
  };
}
