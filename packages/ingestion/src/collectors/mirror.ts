// collectors/mirror.ts: plan how work.collectors follows the steering repo.
//
// The steering repo's work/collectors/*.toml files are the source. This file
// compares them with the rows a workspace holds and returns the writes that
// make the rows match, without making any. The worker applies the plan.
//
// - A new file creates a row.
// - A changed file, by its SHA-256, updates the row.
// - A removed file pauses the row and marks its hash `removed:<old hash>`, so
//   its inbound events and work items keep their collector. When the file
//   comes back, the row resumes. A row a person paused before the removal is
//   marked `removed:paused:<old hash>` and stays paused when the file returns.
// - A file that does not read leaves its row as it was and is reported.
// - A collector keeps its type. A file that changes it is reported, because a
//   new type is a new collector with a new name.
import {
  type CollectorFile,
  collectorNameFromPath,
  isCollectorFilePath,
  readCollectorFile,
} from "./file";
import type { CollectorHealth } from "./health";
import type { CollectorType } from "./types";

/** One file read from the steering repo. */
export interface MirrorSourceFile {
  path: string;
  text: string;
}

/** The work.collectors fields the plan compares. */
export interface MirrorExistingRow {
  id: string;
  name: string;
  type: CollectorType;
  connectionId: string | null;
  fileHash: string;
  health: CollectorHealth;
}

export type MirrorAction =
  | { kind: "create"; file: CollectorFile; connectionId: string | null }
  | {
      kind: "update";
      id: string;
      file: CollectorFile;
      connectionId: string | null;
      /** True when the file came back after removal, so the row leaves paused. */
      resume: boolean;
    }
  | { kind: "pause"; id: string; name: string; fileHash: string }
  | { kind: "invalid"; path: string; errors: string[] };

export interface MirrorPlan {
  actions: MirrorAction[];
  /** Problems that do not stop a write, such as a connection id no row matches. */
  warnings: string[];
}

/** The hash prefix that marks a row whose file was removed. */
export const REMOVED_HASH_PREFIX = "removed:";

/** The prefix for a removed row a person had already paused. */
const REMOVED_PAUSED_HASH_PREFIX = `${REMOVED_HASH_PREFIX}paused:`;

/** True when the row's file was removed. */
export function isRemovedHash(fileHash: string): boolean {
  return fileHash.startsWith(REMOVED_HASH_PREFIX);
}

/** The hash a removed row stores. It keeps whether a person paused it first. */
export function removedHash(row: Pick<MirrorExistingRow, "fileHash" | "health">): string {
  const prefix =
    row.health === "paused" ? REMOVED_PAUSED_HASH_PREFIX : REMOVED_HASH_PREFIX;
  return `${prefix}${row.fileHash}`;
}

/** True when the mirror, not a person, paused the row. */
function mirrorPaused(fileHash: string): boolean {
  return isRemovedHash(fileHash) && !fileHash.startsWith(REMOVED_PAUSED_HASH_PREFIX);
}

/**
 * Plan the writes that make a workspace's collectors match its files.
 * `connections` maps the connection id a file names to the row id it stands
 * for. Files outside work/collectors/ are ignored.
 */
export function planCollectorMirror(
  files: readonly MirrorSourceFile[],
  existing: readonly MirrorExistingRow[],
  connections: ReadonlyMap<string, string>,
): MirrorPlan {
  const actions: MirrorAction[] = [];
  const warnings: string[] = [];
  const byName = new Map(existing.map((row) => [row.name, row]));
  const present = new Set<string>();

  const sorted = [...files]
    .filter((file) => isCollectorFilePath(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const source of sorted) {
    present.add(collectorNameFromPath(source.path));
    const read = readCollectorFile(source.path, source.text);
    if (!read.ok) {
      actions.push({ kind: "invalid", path: read.path, errors: read.errors });
      continue;
    }
    const file = read.file;
    const row = byName.get(file.name);
    if (row && row.type !== file.type) {
      actions.push({
        kind: "invalid",
        path: file.path,
        errors: [
          `type: ${file.name} is a ${row.type} collector and cannot become ${file.type}; give the new collector a new file name`,
        ],
      });
      continue;
    }
    let connectionId: string | null = null;
    if (file.connection !== null) {
      connectionId = connections.get(file.connection) ?? null;
      if (connectionId === null)
        warnings.push(
          `${file.path}: no connection in this workspace has the id ${file.connection}; the collector stores deliveries and fetches nothing until one does`,
        );
    }
    if (!row) {
      actions.push({ kind: "create", file, connectionId });
      continue;
    }
    if (
      isRemovedHash(row.fileHash) ||
      row.fileHash !== file.fileHash ||
      row.connectionId !== connectionId
    )
      actions.push({
        kind: "update",
        id: row.id,
        file,
        connectionId,
        resume: mirrorPaused(row.fileHash),
      });
  }

  for (const row of existing) {
    if (present.has(row.name) || isRemovedHash(row.fileHash)) continue;
    actions.push({
      kind: "pause",
      id: row.id,
      name: row.name,
      fileHash: removedHash(row),
    });
  }
  return { actions, warnings };
}
