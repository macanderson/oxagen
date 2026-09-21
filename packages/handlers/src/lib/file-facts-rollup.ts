import { schema, type withTenantDb } from "@oxagen/database";
import type { TachoEvent } from "@oxagen/tacho";
import { and, eq, sql } from "drizzle-orm";
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
  // So the rows this session already has are read once and keyed the same
  // way, and an entry that matches one reuses that row's stored path. The
  // insert then conflicts as it should and enriches the row rather than
  // adding a second. One query per rollup, not one per file.
  const stored = await tx
    .select({
      path: schema.tachoSessionFiles.path,
      repoRelativePath: schema.tachoSessionFiles.repoRelativePath,
    })
    .from(schema.tachoSessionFiles)
    .where(eq(schema.tachoSessionFiles.sessionId, sessionId));
  const pathByIdentity = new Map(
    stored.map((row) => [fileIdentityOf(row.path).key, row.path]),
  );
  if (observedStatusColumn) {
    for (const row of stored) {
      const identity = fileIdentityOf(row.path);
      if (byPath.get(identity.key)?.observed !== undefined) continue;
      const cleared = [...completeSnapshots.values()].some(
        ({ root, seen }) =>
          repoRelativePathOf(row.path, root) !== undefined &&
          (row.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(row.path)) &&
          !seen.has(identity.key),
      );
      if (!cleared) continue;
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
            eq(schema.tachoSessionFiles.path, row.path),
          ),
        );
    }
  }
  for (const [identity, entry] of byPath) {
    const path = pathByIdentity.get(identity) ?? entry.path;
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
