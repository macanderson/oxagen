/**
 * `oxagen memory` + `oxagen remember` — manage the workspace's agent memories
 * from the shell.
 *
 *   oxagen memory list [--kind k] [--weight w] [--json]
 *   oxagen memory show <id> [--json]
 *   oxagen memory edit <id> [--lesson t] [--kind k] [--source s]
 *   oxagen memory salience <id> <low|high|critical> [--confidence n]
 *   oxagen memory rm <id>
 *   oxagen remember <text...> [--kind k] [--weight w] [--node ref]
 *
 * Every command delegates to lib/memory-client (the shared transport +
 * formatters the REPL slash commands also use) and exits non-zero with a
 * friendly message on an API/auth error.
 */
import { ApiError } from "../lib/api.js";
import {
  listMemories,
  rememberMemory,
  updateMemory,
  deleteMemory,
  formatMemoryLines,
  formatMemoryDetail,
  formatRememberResult,
  MEMORY_KINDS,
  MEMORY_WEIGHTS,
  type MemoryKind,
  type MemoryWeight,
} from "../lib/memory-client.js";

/** Print an error and exit(1) — the one-shot CLI failure contract. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseKind(v: string | undefined): MemoryKind | undefined {
  if (v === undefined) return undefined;
  if (!MEMORY_KINDS.includes(v as MemoryKind)) {
    fail(`Invalid kind "${v}". Use one of: ${MEMORY_KINDS.join(", ")}.`);
  }
  return v as MemoryKind;
}

function parseWeight(v: string | undefined): MemoryWeight | undefined {
  if (v === undefined) return undefined;
  if (!MEMORY_WEIGHTS.includes(v as MemoryWeight)) {
    fail(`Invalid weight "${v}". Use one of: ${MEMORY_WEIGHTS.join(", ")}.`);
  }
  return v as MemoryWeight;
}

function handleApiError(err: unknown): never {
  if (err instanceof ApiError) fail(err.message);
  fail(err instanceof Error ? err.message : String(err));
}

export interface MemoryListCliOptions {
  kind?: string;
  weight?: string;
  node?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
}

export async function handleMemoryList(opts: MemoryListCliOptions): Promise<void> {
  try {
    const result = await listMemories({
      kind: parseKind(opts.kind),
      minWeight: parseWeight(opts.weight),
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
      kind: parseKind(opts.kind),
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

export async function handleMemorySalience(
  id: string,
  weight: string,
  opts: { confidence?: string; json?: boolean },
): Promise<void> {
  const w = parseWeight(weight);
  let confidence: number | undefined;
  if (opts.confidence !== undefined) {
    confidence = Number(opts.confidence);
    if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      fail(`Invalid --confidence "${opts.confidence}". Use a number between 0 and 1.`);
    }
  }
  try {
    const updated = await updateMemory({ memoryId: id, weight: w, confidence });
    if (opts.json) {
      process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `✓ Salience updated — weight ${updated.weight}, confidence ${updated.confidence.toFixed(2)} (${updated.id}).\n`,
    );
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

export interface RememberCliOptions {
  kind?: string;
  weight?: string;
  node?: string;
  json?: boolean;
}

export async function handleRemember(
  text: string,
  opts: RememberCliOptions,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) fail('Nothing to remember. Pass the memory text, e.g. `oxagen remember "…"`.');
  try {
    // source is omitted so the server defaults it to "user" for a human capture.
    const result = await rememberMemory({
      text: trimmed,
      kind: parseKind(opts.kind),
      weight: parseWeight(opts.weight),
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
