import { schema, type withTenantDb } from "@oxagen/database";
import type { TachoEvent } from "@oxagen/tacho";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import {
  fileIdentityOf,
  languageOf,
  observedChangesOf,
  repoRelativePathOf,
  WORKTREE_RECONCILED_KIND,
  worktreeRootOf,
} from "./file-facts";

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];
type Scope = { orgId: string; workspaceId: string };
type Body = Record<string, unknown>;
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * A stored path that already names a worktree.
 *
 * POSIX absolute, a UNC share, or a drive letter. A relative path has none
 * of these, which is how a row written before worktree-qualified identity
 * is recognized: the worktree was not recorded anywhere except, sometimes,
 * as the same text in `repo_relative_path`.
 */
function isAbsoluteStoredPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

/**
 * The repo-relative key of a row stored before a worktree was recorded.
 *
 * Undefined for an absolute path. That row is already a qualified
 * identity and must not also answer for every worktree that holds the
 * same relative name.
 */
function legacyRelativeOf(row: {
  path: string;
  repoRelativePath: string | null;
}): string | undefined {
  if (isAbsoluteStoredPath(row.path)) return undefined;
  const relative =
    row.repoRelativePath !== null && row.repoRelativePath.length > 0
      ? row.repoRelativePath
      : row.path;
  if (relative.length === 0 || isAbsoluteStoredPath(relative)) return undefined;
  return relative;
}

/**
 * The `session_files` rows that count as files one session changed.
 *
 * A file changed by a shell command, a formatter or a build has no attested
 * write, edit or delete, only the `observed_status` the reconciliation gave
 * it, so both halves count. The two halves are joined with `or()` and not
 * written into one `sql` fragment: `and()` does not parenthesise its
 * arguments, so a bare `... > 0 OR observed_status IN (...)` bound looser
 * than the session filter and counted every observed row in the workspace.
 * That is how every run on one laptop came to be titled with the same
 * count of about 2,278 files.
 *
 * `observedStatusColumn` is false until `tacho.session_files.observed_status`
 * exists; the attested writes alone are counted until then.
 */
export function sessionChangedFilesWhere(
  sessionId: string,
  observedStatusColumn: boolean,
): SQL | undefined {
  const attested = sql`${schema.tachoSessionFiles.writes} + ${schema.tachoSessionFiles.edits} + ${schema.tachoSessionFiles.deletes} > 0`;
  return and(
    eq(schema.tachoSessionFiles.sessionId, sessionId),
    observedStatusColumn
      ? or(
          attested,
          inArray(schema.tachoSessionFiles.observedStatus, [
            "added",
            "modified",
            "deleted",
            "renamed",
          ]),
        )
      : attested,
  );
}

export async function rollupFiles(
  tx: Tx,
  ctx: Scope,
  sessionId: string,
  events: TachoEvent[],
  now: Date,
  // Whether `tacho.session_files.observed_status` exists yet. Same window as
  // the gateway columns: the node deploys on merge and the migration is
  // applied by hand afterwards, so naming the column in between raises 42703
  // and takes the batch with it.
  observedStatusColumn: boolean,
): Promise<void> {
  const byPath = new Map<
    string,
    {
      reads: number;
      writes: number;
      edits: number;
      deletes: number;
      first: number;
      last: number;
      bytes: number;
      /** The recorded worktree qualifies relative paths. */
      root?: string;
      path: string;
      /** What the last reconciliation in this batch observed, if any. */
      observed?: {
        status: string | null;
        linesAdded: number;
        linesRemoved: number;
        repoRelativePath?: string;
      };
    }
  >();
  const completeSnapshots = new Map<
    string,
    { root: string; seen: Set<string> }
  >();
  const entryFor = (path: string, seq: number, root?: string) => {
    const identity = fileIdentityOf(path, root);
    const existing = byPath.get(identity.key);
    if (existing !== undefined) return existing;
    return {
      reads: 0,
      writes: 0,
      edits: 0,
      deletes: 0,
      first: seq,
      last: seq,
      bytes: 0,
      // The path the row stores. An absolute one wins if either pass has it,
      // since it is the one a person can act on.
      path: identity.path,
      root,
    };
  };
  for (const event of events) {
    if (event.kind !== "tool_call" && event.kind !== "file_io") continue;
    if (event.kind === "tool_call" && event.source !== "hook") continue;
    const body = event.body as Body;
    const kind = str(body["effect_kind"]);
    const target = str(body["tool_target"]);
    if (!target || !kind || !kind.startsWith("file_")) continue;
    if (event.kind === "tool_call" && kind !== "file_read") continue;
    const root = worktreeRootOf([event.context]);
    const entry = entryFor(target, event.seq, root);
    if (kind === "file_read") entry.reads += 1;
    else if (kind === "file_write") {
      entry.writes += 1;
      entry.bytes += num(body["tool_input_bytes"]);
    } else if (kind === "file_edit") entry.edits += 1;
    else if (kind === "file_delete") entry.deletes += 1;
    entry.first = Math.min(entry.first, event.seq);
    entry.last = Math.max(entry.last, event.seq);
    byPath.set(fileIdentityOf(target, root).key, entry);
  }
  // The observed pass, second so that a path both announced and seen lands
  // on one row. A reconciliation frame reports the whole worktree as git
  // holds it, so a path it names may have no attested frame at all: that is
  // the point of reading it, since a `sed -i`, a formatter or a build
  // changes files no tool announced.
  for (const event of events) {
    if (event.kind !== WORKTREE_RECONCILED_KIND) continue;
    const root = worktreeRootOf([event.context]);
    const changes = observedChangesOf(event.body);
    const seen = new Set(
      changes.map((change) => fileIdentityOf(change.path, root).key),
    );
    if (
      root !== undefined &&
      (event.body as Body)["observed_changes_truncated"] === false
    ) {
      completeSnapshots.set(fileIdentityOf(root).key, { root, seen });
      for (const [key, entry] of byPath) {
        if (
          entry.root !== undefined &&
          fileIdentityOf(entry.root).key === fileIdentityOf(root).key &&
          !seen.has(key) &&
          entry.observed !== undefined
        )
          entry.observed = { status: null, linesAdded: 0, linesRemoved: 0 };
      }
    }
    for (const change of changes) {
      const entry = entryFor(change.path, event.seq, root);
      entry.observed = {
        status: change.status,
        linesAdded: change.lines_added,
        linesRemoved: change.lines_removed,
        ...(change.repo_relative_path.length > 0
          ? { repoRelativePath: change.repo_relative_path }
          : {}),
      };
      entry.first = Math.min(entry.first, event.seq);
      entry.last = Math.max(entry.last, event.seq);
      // Git reports an absolute path, which is the better one to store when
      // the attested pass only had a relative one.
      entry.path = fileIdentityOf(change.path, root).path;
      byPath.set(fileIdentityOf(change.path, root).key, entry);
    }
  }
  if (byPath.size === 0 && completeSnapshots.size === 0) return;
  // Identity has to hold across batches, not only inside one.
  //
  // The conflict key on this table is (session_id, path), so two batches
  // naming one file differently still make two rows: the attested frame
  // arrives with a relative `src/a.ts` and the reconciliation, which is
  // asynchronous and usually lands a batch or more later, arrives with the
  // absolute `/repo/src/a.ts`. Normalizing inside the batch fixed only the
  // case where both happen to travel together, which is the case a test
  // constructs and the rarer one in practice.
  //
  // So the rows this session already has are read once. An entry that
  // matches one reuses that row's stored path, the insert conflicts, and
  // the row is enriched rather than duplicated. One query per rollup, not
  // one per file.
  //
  // Keying is `fileIdentityOf`. An absolute stored path matches a later
  // observation of that same path. A row written before a worktree was
  // recorded stored a relative path, commonly the same text in
  // `repo_relative_path`. `fileIdentityOf` on that path alone is
  // `unplaced:<path>`, and the reconciliation is `absolute:<root>/<path>`,
  // so that key misses. Those rows are also indexed by `repoRelativePath`
  // onto the qualified identity of an entry in this batch that names the
  // same relative path. An absolute stored row already occupying that
  // identity keeps it. One relative row binds to one identity, so two
  // worktrees that each hold an absolute `src/a.ts` stay two rows.
  const stored = await tx
    .select({
      path: schema.tachoSessionFiles.path,
      repoRelativePath: schema.tachoSessionFiles.repoRelativePath,
      linesAdded: schema.tachoSessionFiles.linesAdded,
      linesRemoved: schema.tachoSessionFiles.linesRemoved,
      // Only asked for once the column exists, as everywhere else this flag
      // gates `observedStatus` (see `refreshSessionTitle`): naming it in a
      // select before the migration lands raises 42703 the same way naming
      // it in a write does.
      ...(observedStatusColumn
        ? { observedStatus: schema.tachoSessionFiles.observedStatus }
        : {}),
    })
    .from(schema.tachoSessionFiles)
    .where(eq(schema.tachoSessionFiles.sessionId, sessionId));
  const pathByIdentity = new Map<string, string>();
  const legacyByRelative = new Map<string, string>();
  for (const row of stored) {
    pathByIdentity.set(fileIdentityOf(row.path).key, row.path);
    const relative = legacyRelativeOf(row);
    if (relative !== undefined && !legacyByRelative.has(relative))
      legacyByRelative.set(relative, row.path);
  }
  for (const [identity, entry] of byPath) {
    if (pathByIdentity.has(identity)) continue;
    const relative =
      entry.observed?.repoRelativePath ??
      (entry.root === undefined
        ? undefined
        : repoRelativePathOf(entry.path, entry.root));
    if (relative === undefined) continue;
    const legacyPath = legacyByRelative.get(relative);
    if (legacyPath === undefined) continue;
    pathByIdentity.set(identity, legacyPath);
    legacyByRelative.delete(relative);
  }
  if (observedStatusColumn) {
    // One set-based UPDATE for every path a complete snapshot clears, not one
    // awaited statement per row. A row already at rest (null status, zero
    // counts) is skipped rather than rewritten, so a session that
    // accumulated thousands of paths does not re-clear them on every
    // subsequent clean snapshot.
    const toClear: string[] = [];
    for (const row of stored) {
      const identity = fileIdentityOf(row.path);
      if (byPath.get(identity.key)?.observed !== undefined) continue;
      if (
        row.observedStatus === null &&
        row.linesAdded === 0 &&
        row.linesRemoved === 0
      )
        continue;
      const cleared = [...completeSnapshots.values()].some(
        ({ root, seen }) =>
          repoRelativePathOf(row.path, root) !== undefined &&
          isAbsoluteStoredPath(row.path) &&
          !seen.has(identity.key),
      );
      if (!cleared) continue;
      toClear.push(row.path);
    }
    if (toClear.length > 0) {
      await tx
        .update(schema.tachoSessionFiles)
        .set({
          observedStatus: null,
          linesAdded: 0,
          linesRemoved: 0,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tachoSessionFiles.sessionId, sessionId),
            inArray(schema.tachoSessionFiles.path, toClear),
          ),
        );
    }
  }
  for (const [identity, entry] of byPath) {
    const storedPath = pathByIdentity.get(identity);
    const path = storedPath ?? entry.path;
    // The conflict target stays the path the row already has. When that
    // path is still relative and this batch has the absolute one, record
    // the absolute path on the same row. The next batch then matches it
    // by file identity, and a later complete snapshot can clear it. A
    // relative path would keep the observation on a row the clear pass
    // skips, because a relative path looks inside every worktree.
    const qualifyLegacy =
      storedPath !== undefined &&
      storedPath !== entry.path &&
      !isAbsoluteStoredPath(storedPath) &&
      isAbsoluteStoredPath(entry.path);
    await tx
      .insert(schema.tachoSessionFiles)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        sessionId,
        path,
        // The observed frame carries the repository it read the path in, so
        // it is preferred over deriving one from the batch's worktree
        // context: git answered the question the derivation guesses at.
        repoRelativePath:
          entry.observed?.repoRelativePath ??
          repoRelativePathOf(path, entry.root),
        language: languageOf(path),
        reads: entry.reads,
        writes: entry.writes,
        edits: entry.edits,
        deletes: entry.deletes,
        bytesWritten: entry.bytes,
        // Zero for a row with no observation, which is the column's default
        // and stays honest: nobody looked.
        linesAdded: entry.observed?.linesAdded ?? 0,
        linesRemoved: entry.observed?.linesRemoved ?? 0,
        ...(observedStatusColumn
          ? { observedStatus: entry.observed?.status }
          : {}),
        firstSeq: entry.first,
        lastSeq: entry.last,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.tachoSessionFiles.sessionId,
          schema.tachoSessionFiles.path,
        ],
        set: {
          ...(qualifyLegacy ? { path: entry.path } : {}),
          reads: sql`${schema.tachoSessionFiles.reads} + ${entry.reads}`,
          writes: sql`${schema.tachoSessionFiles.writes} + ${entry.writes}`,
          edits: sql`${schema.tachoSessionFiles.edits} + ${entry.edits}`,
          deletes: sql`${schema.tachoSessionFiles.deletes} + ${entry.deletes}`,
          bytesWritten: sql`${schema.tachoSessionFiles.bytesWritten} + ${entry.bytes}`,
          // COALESCE and not an overwrite: a later batch may carry no
          // worktree context, and a path that was once placed in its
          // repository does not stop being there because the next frame
          // arrived without the fact.
          repoRelativePath: sql`COALESCE(${entry.observed?.repoRelativePath ?? null}, ${schema.tachoSessionFiles.repoRelativePath}, ${repoRelativePathOf(path, entry.root) ?? null})`,
          language: sql`COALESCE(${schema.tachoSessionFiles.language}, ${languageOf(path) ?? null})`,
          lastSeq: sql`GREATEST(${schema.tachoSessionFiles.lastSeq}, ${entry.last})`,
          // The two line counts do NOT accumulate, alone on this row among
          // columns that all do. Every other column here counts events, and
          // two batches carrying two tool calls are two tool calls. These
          // two are a measurement, not a count: each reconciliation reports
          // the whole difference between the worktree and HEAD, so the same
          // unchanged file observed on three turns would add up to three
          // times the lines it holds.
          //
          // Within an observation the two counts are assigned together,
          // because they are one measurement of one worktree against HEAD,
          // not two running totals. Taking the larger of each column on its
          // own crossed observations: 12/3 followed by 2/10 left 12/10, a
          // state git never reported and nobody could have produced. The
          // envelope contract says these are assigned rather than
          // accumulated, and this is the same reasoning `observedStatus`
          // below already follows.
          //
          // Left alone when this batch carried no observation of the path,
          // so an attested frame arriving later does not zero a count that
          // git supplied.
          ...(entry.observed === undefined
            ? {}
            : {
                linesAdded: entry.observed.linesAdded,
                linesRemoved: entry.observed.linesRemoved,
                // Assigned, not kept: the latest observation is the current
                // condition of the path, and a file created and then deleted
                // is deleted.
                ...(observedStatusColumn
                  ? { observedStatus: entry.observed.status }
                  : {}),
              }),
          updatedAt: now,
        },
      });
  }
}
