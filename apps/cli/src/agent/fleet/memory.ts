/**
 * Fleet memory — a local, dependency-free record of what the agent army builds
 * and fixes, with lexical recall.
 *
 * This complements the engram/DuckDB episodic store ({@link openSessionMemory}).
 * That store is best-effort and silently disables itself when its optional native
 * dependency is missing; this one is plain JSON Lines on disk, so memory
 * recording is *guaranteed* — which is what the user asked for ("record the
 * memories as it fixes/builds things"). It mirrors the platform's weighted
 * `agent.memory.write` shape (kind + weight + lesson) so the same lessons can be
 * promoted to the knowledge graph later.
 *
 * Recall is a transparent lexical scorer (term overlap + file overlap + weight),
 * not embeddings: it needs no model call, works offline, and is good enough to
 * surface the handful of relevant lessons that should steer the next task.
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { MemoryRecord } from "./types.js";

/** Stable per-project key from the working directory name. */
function projectKey(cwd: string): string {
  return basename(cwd) || "default";
}

function memoryPath(cwd: string): string {
  return join(homedir(), ".config", "oxagen", "memories", `${projectKey(cwd)}.jsonl`);
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is",
  "are", "be", "this", "that", "it", "as", "at", "by", "from", "into", "we",
  "you", "i", "fix", "add", "the", "use", "code", "file", "files",
]);

/** Split text into lowercased, de-stopped terms for lexical scoring. */
function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t),
  );
}

export interface FleetMemory {
  /** Append a weighted lesson. Never throws — recording must not break a run. */
  record(rec: Omit<MemoryRecord, "id" | "createdAt">): void;
  /** Return the most relevant lessons for a query, best first. */
  recall(query: string, opts?: { limit?: number; files?: string[] }): MemoryRecord[];
  /** All records, newest first (for the agents screen memory panel). */
  all(): MemoryRecord[];
}

let counter = 0;
function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `mem_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * Open (or create) the project's fleet memory. Reads are cached in-process and
 * invalidated on every write, so a long-lived REPL/agents screen sees its own
 * appends without re-reading the file each recall.
 */
export function openFleetMemory(cwd: string): FleetMemory {
  const path = memoryPath(cwd);
  let cache: MemoryRecord[] | null = null;

  function load(): MemoryRecord[] {
    if (cache) return cache;
    if (!existsSync(path)) {
      cache = [];
      return cache;
    }
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      cache = lines
        .map((l) => {
          try {
            return JSON.parse(l) as MemoryRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is MemoryRecord => r !== null);
    } catch {
      cache = [];
    }
    return cache;
  }

  return {
    record(rec) {
      const full: MemoryRecord = { ...rec, id: newId(), createdAt: Date.now() };
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
        if (cache) cache.push(full);
        else cache = [full];
      } catch {
        /* memory is best-effort — never break the run over a failed append */
      }
    },

    recall(query, opts = {}) {
      const limit = opts.limit ?? 5;
      const qTerms = new Set(terms(query));
      const qFiles = new Set((opts.files ?? []).map((f) => f));
      const weightBoost = { low: 0, high: 1, critical: 2 } as const;

      const scored = load()
        .map((r) => {
          const rTerms = terms(r.lesson + " " + r.files.join(" "));
          let overlap = 0;
          for (const t of rTerms) if (qTerms.has(t)) overlap++;
          let fileOverlap = 0;
          for (const f of r.files) if (qFiles.has(f)) fileOverlap++;
          const score = overlap + fileOverlap * 3 + weightBoost[r.weight];
          return { r, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || b.r.createdAt - a.r.createdAt);

      return scored.slice(0, limit).map((s) => s.r);
    },

    all() {
      return [...load()].sort((a, b) => b.createdAt - a.createdAt);
    },
  };
}

/** Render recalled lessons as a compact context block for prompt injection. */
export function formatLessons(records: MemoryRecord[]): string {
  if (records.length === 0) return "";
  return records
    .map((r) => {
      const mark = r.weight === "critical" ? "‼" : r.weight === "high" ? "!" : "·";
      const files = r.files.length ? ` [${r.files.slice(0, 3).join(", ")}]` : "";
      return `${mark} (${r.kind}) ${r.lesson}${files}`;
    })
    .join("\n");
}
