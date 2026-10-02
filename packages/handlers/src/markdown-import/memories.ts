// markdown-import/memories.ts: the Markdown import's Memories target
// (memory-collection spec, Bulk import: Commit).
//
// A file imported as memories is split like a records file, and each
// statement becomes a memory row with kind memory and force info. Commit
// stores each row marked add the way the memory pipeline stores a memory from
// outside a run (memory/runner.ts, ingestMemories): capture `import`, no
// agent, no run, a source of `import:<file>#L<line>`, and a dedupe key of the
// capture, the source, and the statement hash. memory/v1 has no author field,
// so the row attributes the memory the one way it can: capture `import` with
// no agent says a person wrote it, not an agent. The kernel's audit of the
// commit call records which person.
//
// A statement the workspace already holds is left out and named: a waiting
// memory with the same statement hash, a statement a person rejected
// (memory_rejections), or an earlier row of the same import. Parse marks
// these rows skip, and commit checks them again, because a memory can arrive
// or a rejection be recorded between the two calls.
import type {
  MarkdownImportMemory,
  MarkdownImportMemoryMatch,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { MEMORY_STATEMENT_MAX } from "@oxagen/oxagen/steering-repo/memory";
import { statementHash } from "../memory/statement";
import type { MemoryDraft } from "../memory/types";
import { labelOf } from "./naming";

/** The waiting memories and the rejected statements a memory row is checked against. */
export interface HeldMemories {
  /** Each waiting memory's public id and statement hash. */
  waiting: Array<{ publicId: string; statementHash: string }>;
  /** The statement hash of each statement a person rejected. */
  rejected: string[];
}

/** Where an imported memory came from: `import:<file>#L<line>`. */
export function importMemorySource(file: string, line: number): string {
  return `import:${file}#L${line}`;
}

/** Why a statement cannot be stored as a memory, or null when it can. */
export function memoryIssue(statement: string): string | null {
  if (statement.length <= MEMORY_STATEMENT_MAX) return null;
  return `A memory holds at most ${MEMORY_STATEMENT_MAX.toLocaleString("en-US")} characters, and this statement has ${statement.length.toLocaleString("en-US")}. Import the file as records to keep it.`;
}

/** A memory row from one statement of a file, before it is checked for matches. */
export function memoryRow(args: {
  file: string;
  line: number;
  label: string | null;
  statement: string;
}): MarkdownImportMemory {
  const issue = memoryIssue(args.statement);
  return {
    file: args.file,
    line: args.line,
    label: labelOf(args.label, args.statement),
    statement: args.statement,
    kind: "memory",
    force: "info",
    duplicate: null,
    issue,
    action: issue === null ? "add" : "skip",
  };
}

/**
 * Finds what each statement says again, in order: a waiting memory, then a
 * rejected statement, then an earlier statement passed to `find`.
 */
export function memoryMatcher(held: HeldMemories) {
  const waiting = new Map<string, string>();
  for (const memory of held.waiting) {
    if (!waiting.has(memory.statementHash)) {
      waiting.set(memory.statementHash, memory.publicId);
    }
  }
  const rejected = new Set(held.rejected);
  const earlier = new Map<string, { file: string; line: number }>();
  return (row: Pick<MarkdownImportMemory, "file" | "line" | "statement">): MarkdownImportMemoryMatch | null => {
    const hash = statementHash(row.statement);
    const memory = waiting.get(hash);
    if (memory !== undefined) {
      return { reason: "waiting", memory, file: null, line: null };
    }
    if (rejected.has(hash)) {
      return { reason: "rejected", memory: null, file: null, line: null };
    }
    const first = earlier.get(hash);
    if (first !== undefined) {
      return { reason: "import", memory: null, file: first.file, line: first.line };
    }
    earlier.set(hash, { file: row.file, line: row.line });
    return null;
  };
}

/**
 * The rows with what each one says again marked. A row with a match is
 * skipped. A row that matches nothing keeps its action.
 */
export function markMemoryRows(
  rows: readonly MarkdownImportMemory[],
  held: HeldMemories,
): MarkdownImportMemory[] {
  const find = memoryMatcher(held);
  return rows.map((row): MarkdownImportMemory => {
    const duplicate = find(row);
    return duplicate === null ? row : { ...row, duplicate, action: "skip" };
  });
}

/** The memory commit stores for one row: a waiting memory a person imported. */
export function memoryDraftOf(row: MarkdownImportMemory): MemoryDraft {
  const source = importMemorySource(row.file, row.line);
  const hash = statementHash(row.statement);
  return {
    agentLineage: null,
    runPublicId: null,
    capture: "import",
    statement: row.statement,
    statementHash: hash,
    kind: "memory",
    repos: null,
    appliesTo: null,
    tools: null,
    // A memory with no run cites no frame (memory/v1 `evidence`).
    evidence: [],
    source,
    dedupeKey: `import:${source}:${hash}`,
    label: row.label,
  };
}
