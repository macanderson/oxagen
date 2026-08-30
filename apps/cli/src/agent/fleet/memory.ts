/**
 * Fleet memory — a local, dependency-free record of what the agent army builds
 * and fixes, with lexical recall.
 *
 * This complements the engram/DuckDB episodic store ({@link openSessionMemory}).
 * That store is best-effort and silently disables itself when its optional native
 * dependency is missing; this one is plain JSON Lines on disk, so memory
 * recording is *guaranteed* — which is what the user asked for ("record the
 * memories as it fixes/builds things"). It mirrors the platform's two-axis
 * `agent.memory.write` shape (memoryKind + memoryClass/enforcementScore + lesson)
 * so the same lessons can be promoted to the knowledge graph later.
 *
 * Recall is a transparent lexical scorer (term overlap + file overlap + class/
 * enforcement boost), not embeddings: it needs no model call, works offline, and
 * is good enough to surface the handful of relevant lessons that should steer
 * the next task.
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * A two-axis lesson recorded as the CLI builds/fixes code, persisted as one
 * JSON line in this store. Mirrors the platform's `agent.memory.write` shape
 * (memoryKind + memoryClass/enforcementScore + lesson) so the same lessons can
 * be promoted to the knowledge graph.
 *
 * It lives here, with its only store, rather than in `fleet/types.ts` — that
 * module forwards the engine's task/plan/snapshot shapes, and this record is
 * specific to the CLI's local lesson store.
 */
export interface MemoryRecord {
  id: string;
  createdAt: number;
  /** Content domain — mirrors the platform `agent.memory.write` memoryKind values. */
  memoryKind:
    | "routine-change"
    | "constraint"
    | "bug-root-cause"
    | "convention-deviation"
    | "gotcha";
  /** Epistemic class — mirrors the platform `agent.memory.write` memoryClass ladder. */
  memoryClass: "OBSERVATION" | "RULE" | "FACT";
  /** How strongly it should influence future work; 1-100 for RULE, null otherwise. */
  enforcementScore: number | null;
  /** The lesson itself, in one or two sentences. */
  lesson: string;
  /** Files the lesson is about (used for lexical recall scoring). */
  files: string[];
  /** Task that produced it, if any. */
  taskId?: string;
  outcome: "success" | "failure";
}

/** Stable per-project key from the working directory name. */
function projectKey(cwd: string): string {
  return basename(cwd) || "default";
}

function memoryPath(cwd: string): string {
  return join(
    homedir(),
    ".config",
    "oxagen",
    "memories",
    `${projectKey(cwd)}.jsonl`,
  );
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "as",
  "at",
  "by",
  "from",
  "into",
  "we",
  "you",
  "i",
  "fix",
  "add",
  "use",
  "code",
  "file",
  "files",
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
  recall(
    query: string,
    opts?: { limit?: number; files?: string[] },
  ): MemoryRecord[];
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
      } catch (err) {
        // Memory is best-effort — never break the run over a failed append —
        // but leave a breadcrumb under OXAGEN_DEBUG so a silently-missing
        // lesson record can be diagnosed rather than leaving an unexplained gap.
        if (process.env["OXAGEN_DEBUG"])
          process.stderr.write(
            `[fleet-memory] record failed (${path}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
      }
    },

    recall(query, opts = {}) {
      const limit = opts.limit ?? 5;
      const qTerms = new Set(terms(query));
      const qFiles = new Set(opts.files ?? []);

      const scored = load()
        .map((r) => {
          const rTerms = terms(r.lesson + " " + r.files.join(" "));
          let overlap = 0;
          for (const t of rTerms) if (qTerms.has(t)) overlap++;
          let fileOverlap = 0;
          for (const f of r.files) if (qFiles.has(f)) fileOverlap++;
          const score = overlap + fileOverlap * 3 + classBoost(r);
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

/**
 * Recall boost from a lesson's epistemic class + enforcement, on a 0–2 scale:
 * OBSERVATION never boosts, a RULE boosts by its enforcement strength (2 at
 * ≥90, else 1), and FACT (always enforcement 100) boosts like a strong RULE.
 */
function classBoost(r: MemoryRecord): number {
  if (r.memoryClass === "OBSERVATION") return 0;
  if (r.memoryClass === "FACT") return 2;
  return (r.enforcementScore ?? 0) >= 90 ? 2 : 1;
}

/** Marker glyph for a lesson's class/enforcement: `·` / `!` / `‼` by strength. */
function classMark(r: MemoryRecord): string {
  if (r.memoryClass === "OBSERVATION") return "·";
  return classBoost(r) >= 2 ? "‼" : "!";
}

/** Render recalled lessons as a compact context block for prompt injection. */
export function formatLessons(records: MemoryRecord[]): string {
  if (records.length === 0) return "";
  return records
    .map((r) => {
      const mark = classMark(r);
      const files = r.files.length
        ? ` [${r.files.slice(0, 3).join(", ")}]`
        : "";
      return `${mark} (${r.memoryKind}) ${r.lesson}${files}`;
    })
    .join("\n");
}
