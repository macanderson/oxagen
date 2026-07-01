/**
 * `oxagen memory` + `oxagen remember` — manage the workspace's agent memories
 * from the shell.
 *
 *   oxagen memory list [--class OBSERVATION|RULE|FACT] [--kind k] [--min-enforcement n] [--json]
 *   oxagen memory show <id> [--json]
 *   oxagen memory edit <id> [--lesson t] [--kind k] [--source s]
 *   oxagen memory salience <id> [--confidence n] [--enforcement n] [--status s]
 *   oxagen memory promote <id> --to rule|fact [--enforcement n] --rationale "…"
 *   oxagen memory candidates [--limit n]
 *   oxagen memory rm <id>
 *   oxagen remember <text...> [--class c] [--kind k] [--enforcement n] [--node ref]
 *
 * Every command delegates to lib/memory-client (the shared transport +
 * formatters the REPL slash commands also use) and exits non-zero with a
 * friendly message on an API/auth error.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ApiError } from "../lib/api.js";
import {
  listMemories,
  rememberMemory,
  updateMemory,
  deleteMemory,
  promoteMemory,
  promotionCandidates,
  parseImportMemories,
  commitImportMemories,
  formatMemoryLines,
  formatMemoryDetail,
  formatRememberResult,
  formatPromoteResult,
  formatPromotionCandidates,
  formatImportDrafts,
  formatImportResults,
  RECOMMENDED_MEMORY_KINDS,
  MEMORY_CLASSES,
  type MemoryClass,
  type MemoryStatus,
} from "../lib/memory-client.js";

/** Print an error and exit(1) — the one-shot CLI failure contract. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// memoryKind is an open string per the two-axis model — accept anything, but
// keep the recommended set around for hinting.
function normalizeKind(v: string | undefined): string | undefined {
  return v === undefined ? undefined : v;
}

function parseClass(v: string | undefined): MemoryClass | undefined {
  if (v === undefined) return undefined;
  const upper = v.toUpperCase();
  if (!MEMORY_CLASSES.includes(upper as MemoryClass)) {
    fail(`Invalid class "${v}". Use one of: ${MEMORY_CLASSES.join(", ")}.`);
  }
  return upper as MemoryClass;
}

function parseStatus(v: string | undefined): MemoryStatus | undefined {
  if (v === undefined) return undefined;
  const upper = v.toUpperCase();
  const STATUSES = ["ACTIVE", "SUPERSEDED", "RETRACTED", "ARCHIVED"];
  if (!STATUSES.includes(upper)) {
    fail(`Invalid status "${v}". Use one of: ${STATUSES.join(", ")}.`);
  }
  return upper as MemoryStatus;
}

function parseIntOpt(v: string | undefined, label: string): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) fail(`Invalid ${label} "${v}". Use an integer.`);
  return n;
}

function handleApiError(err: unknown): never {
  if (err instanceof ApiError) fail(err.message);
  fail(err instanceof Error ? err.message : String(err));
}

export interface MemoryListCliOptions {
  class?: string;
  kind?: string;
  minEnforcement?: string;
  node?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
}

export async function handleMemoryList(opts: MemoryListCliOptions): Promise<void> {
  try {
    const result = await listMemories({
      memoryClass: parseClass(opts.class),
      memoryKind: normalizeKind(opts.kind),
      minEnforcement: parseIntOpt(opts.minEnforcement, "--min-enforcement"),
      nodeRef: opts.node,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatMemoryLines(result) + "\n");
  } catch (err) {
    handleApiError(err);
  }
}

export async function handleMemoryShow(
  idOrPublicId: string,
  opts: { json?: boolean },
): Promise<void> {
  try {
    // No get-by-id capability exists; fetch a page and resolve client-side by
    // full id or publicId (or an unambiguous short-id prefix).
    const { memories } = await listMemories({ limit: 200 });
    const match =
      memories.find((m) => m.id === idOrPublicId || m.publicId === idOrPublicId) ??
      memories.find((m) => m.id.startsWith(idOrPublicId));
    if (!match) {
      fail(`No memory matching "${idOrPublicId}" in this workspace (searched the latest 200).`);
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(match, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatMemoryDetail(match) + "\n");
  } catch (err) {
    handleApiError(err);
  }
}

export interface MemoryEditCliOptions {
  lesson?: string;
  kind?: string;
  source?: string;
  json?: boolean;
}

export async function handleMemoryEdit(
  id: string,
  opts: MemoryEditCliOptions,
): Promise<void> {
  if (!opts.lesson && !opts.kind && !opts.source) {
    fail("Nothing to edit. Pass at least one of --lesson, --kind, or --source.");
  }
  try {
    const updated = await updateMemory({
      memoryId: id,
      lesson: opts.lesson,
      memoryKind: normalizeKind(opts.kind),
      source: opts.source,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
      return;
    }
    process.stdout.write(`✓ Updated memory ${updated.id}.\n${formatMemoryDetail(updated)}\n`);
  } catch (err) {
    handleApiError(err);
  }
}

export interface MemorySalienceCliOptions {
  confidence?: string;
  enforcement?: string;
  status?: string;
  json?: boolean;
}

/**
 * `oxagen memory salience <id>` — adjust a memory's confidence/enforcement
 * scores or lifecycle status. Class changes go through `oxagen memory promote`
 * (the only path that can move a memory up the confidence ladder).
 */
export async function handleMemorySalience(
  id: string,
  opts: MemorySalienceCliOptions,
): Promise<void> {
  if (!opts.confidence && !opts.enforcement && !opts.status) {
    fail("Nothing to update. Pass at least one of --confidence, --enforcement, or --status.");
  }
  let confidenceScore: number | undefined;
  if (opts.confidence !== undefined) {
    confidenceScore = Number(opts.confidence);
    if (Number.isNaN(confidenceScore) || confidenceScore < 0 || confidenceScore > 100) {
      fail(`Invalid --confidence "${opts.confidence}". Use a number between 0 and 100.`);
    }
  }
  let enforcementScore: number | undefined;
  if (opts.enforcement !== undefined) {
    enforcementScore = Number(opts.enforcement);
    if (
      !Number.isInteger(enforcementScore) ||
      enforcementScore < 1 ||
      enforcementScore > 100
    ) {
      fail(`Invalid --enforcement "${opts.enforcement}". Use an integer between 1 and 100.`);
    }
  }
  const status = parseStatus(opts.status);
  try {
    const updated = await updateMemory({ memoryId: id, confidenceScore, enforcementScore, status });
    if (opts.json) {
      process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `✓ Salience updated — class ${updated.memoryClass}, confidence ${updated.confidenceScore.toFixed(1)}, enforcement ${updated.enforcementScore ?? "—"} (${updated.id}).\n`,
    );
  } catch (err) {
    handleApiError(err);
  }
}

export interface MemoryPromoteCliOptions {
  to?: string;
  enforcement?: string;
  rationale?: string;
  json?: boolean;
}

/**
 * `oxagen memory promote <id> --to rule|fact --rationale "…"` — move a memory
 * up the confidence ladder, recording an auditable :Promotion event. FACT
 * requires human confirmation server-side, which this CLI invocation provides.
 */
export async function handleMemoryPromote(
  id: string,
  opts: MemoryPromoteCliOptions,
): Promise<void> {
  if (!opts.to) fail("Missing --to. Use `--to rule` or `--to fact`.");
  const toClass = opts.to.toUpperCase();
  if (toClass !== "RULE" && toClass !== "FACT") {
    fail(`Invalid --to "${opts.to}". Use "rule" or "fact".`);
  }
  if (!opts.rationale) fail("Missing --rationale. Explain why this memory is being promoted.");
  let enforcementScore: number | undefined;
  if (opts.enforcement !== undefined) {
    enforcementScore = Number(opts.enforcement);
    if (
      !Number.isInteger(enforcementScore) ||
      enforcementScore < 1 ||
      enforcementScore > 100
    ) {
      fail(`Invalid --enforcement "${opts.enforcement}". Use an integer between 1 and 100.`);
    }
  }
  try {
    const updated = await promoteMemory({
      memoryId: id,
      toClass,
      enforcementScore,
      rationale: opts.rationale,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatPromoteResult(updated) + "\n");
  } catch (err) {
    handleApiError(err);
  }
}

export interface MemoryCandidatesCliOptions {
  limit?: string;
  json?: boolean;
}

/** `oxagen memory candidates` — the OBSERVATIONs most ready to promote. */
export async function handleMemoryCandidates(
  opts: MemoryCandidatesCliOptions,
): Promise<void> {
  try {
    const result = await promotionCandidates({
      limit: parseIntOpt(opts.limit, "--limit"),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatPromotionCandidates(result) + "\n");
  } catch (err) {
    handleApiError(err);
  }
}

export async function handleMemoryRemove(id: string): Promise<void> {
  try {
    const { deleted } = await deleteMemory(id);
    if (deleted) {
      process.stdout.write(`✓ Deleted memory ${id}.\n`);
    } else {
      fail(`No memory ${id} found in this workspace.`);
    }
  } catch (err) {
    handleApiError(err);
  }
}

export interface MemoryImportCliOptions {
  node?: string;
  /** Commit the parsed drafts. Without it, the command only previews them. */
  yes?: boolean;
  json?: boolean;
}

/**
 * `oxagen memory import <files...>` — bulk-import markdown skill files / rule
 * docs into the workspace AgentMemory graph.
 *
 * Two phases mirror the parse → commit capability pair: every file is read and
 * sent to agent.memory.import.parse, which classifies atomic draft memories.
 * Importing is gated behind --yes (safe by default), so a bare invocation
 * previews the drafts table and writes nothing — the editable review grid is the
 * app's job; the CLI's review is the printed table plus an explicit --yes.
 */
export async function handleMemoryImport(
  files: string[],
  opts: MemoryImportCliOptions,
): Promise<void> {
  if (files.length === 0) {
    fail("Nothing to import. Pass one or more markdown files, e.g. `oxagen memory import rules.md`.");
  }

  // Read every file; collect read failures rather than aborting the batch.
  const documents: { filename: string; content: string }[] = [];
  const unreadable: string[] = [];
  for (const path of files) {
    try {
      const content = await readFile(path, "utf8");
      if (content.trim().length === 0) {
        unreadable.push(`${path} (empty)`);
        continue;
      }
      documents.push({ filename: basename(path), content });
    } catch {
      unreadable.push(path);
    }
  }
  if (unreadable.length > 0) {
    process.stderr.write(`⚠ Skipped unreadable/empty files:\n  ${unreadable.join("\n  ")}\n`);
  }
  if (documents.length === 0) {
    fail("No readable, non-empty documents to import.");
  }

  try {
    const parsed = await parseImportMemories(documents, opts.node);

    // Preview-only (no --yes): print drafts (or JSON) and stop without writing.
    if (!opts.yes) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
        return;
      }
      process.stdout.write(formatImportDrafts(parsed.drafts) + "\n");
      for (const s of parsed.skipped) {
        process.stderr.write(`  · skipped ${s.filename}: ${s.reason}\n`);
      }
      if (parsed.drafts.length > 0) {
        process.stdout.write("\nRe-run with --yes to import these memories.\n");
      }
      return;
    }

    if (parsed.drafts.length === 0) {
      fail("No memories could be extracted from the supplied documents.");
    }

    const result = await commitImportMemories(parsed.drafts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatImportResults(result) + "\n");
  } catch (err) {
    handleApiError(err);
  }
}

export interface RememberCliOptions {
  class?: string;
  kind?: string;
  enforcement?: string;
  node?: string;
  json?: boolean;
}

export async function handleRemember(
  text: string,
  opts: RememberCliOptions,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) fail('Nothing to remember. Pass the memory text, e.g. `oxagen remember "…"`.');
  let enforcementScore: number | undefined;
  if (opts.enforcement !== undefined) {
    enforcementScore = Number(opts.enforcement);
    if (
      !Number.isInteger(enforcementScore) ||
      enforcementScore < 1 ||
      enforcementScore > 100
    ) {
      fail(`Invalid --enforcement "${opts.enforcement}". Use an integer between 1 and 100.`);
    }
  }
  try {
    // source is omitted so the server defaults it to "user" for a human capture.
    const result = await rememberMemory({
      text: trimmed,
      memoryClass: parseClass(opts.class),
      memoryKind: normalizeKind(opts.kind),
      enforcementScore,
      nodeRef: opts.node,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatRememberResult(result) + "\n");
  } catch (err) {
    handleApiError(err);
  }
}

// Re-exported for command registration help text (e.g. `--kind <k>` hints).
export { RECOMMENDED_MEMORY_KINDS };
