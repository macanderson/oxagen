// context.record.source.ts — where a published record is read back from
// (ADR-061; MC spec §10.2).
//
// The record is the file. Its file under `.oxagen/rules/` on the workspace's
// production branch is what Stella loads and what steers a run; the Postgres
// registry is a mirror kept for listing, filtering and the promotions ledger.
// So a read resolves the file through the repository binding and answers from
// its bytes, with the commit that last touched it as the record's provenance.
//
// The mirror is the fallback, not the source. A workspace with no bound main
// repository has no file to read, and GitHub can refuse a call that would
// otherwise have succeeded; in both cases the mirror is better than nothing,
// and the answer says which one it is (`backing`) rather than passing a mirror
// off as the file.
import type { GitHubPathCommit } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { lineageIdSchema } from "@oxagen/oxagen/contracts/context.steering.shared";
import type { SteeringGitHub } from "./context.steering.github";
import type { SteeringStore } from "./context.steering.store";
import {
  type ParsedRecordFile,
  readRecordFile,
  recordFilePath,
} from "./context.steering.file";
import { logger } from "./logger";
import { isRepositoryRecord } from "./context.steering.sync.plan";

export interface RecordFileRead {
  /** The record as its file spells it. */
  file: ParsedRecordFile;
  /** The file under `.oxagen/rules/`: the registry's path, else `<lineage>.toml`. */
  path: string;
  /** `owner/name` as the binding approved it. */
  repository: string;
  /** The production branch the file was read from. */
  ref: string;
  /** The commit that last touched the file on `ref`; null when git has none. */
  commit: GitHubPathCommit | null;
}

/**
 * Read one lineage's record file from the workspace's main repository, or null
 * when there is no file to read.
 *
 * Null covers three different situations on purpose — no repository is bound,
 * the path does not exist on the production branch, and the file is not a
 * context-record/v0.1 file this can parse — because a caller does the same
 * thing in all three: fall back to the mirror and say so. What a caller must
 * never do is treat a GitHub refusal as an empty answer, so those are logged
 * here with the lineage attached and still collapse to null rather than
 * failing the read: a Context PR that cannot be opened is a broken write, but
 * a record that cannot be displayed is a page the reader cannot use at all.
 */
export async function readRecordFromRepo(
  github: SteeringGitHub,
  scope: { orgId: string; workspaceId: string },
  lineageId: string,
  /**
   * Where the registry last saw the file. A person can rename or move a
   * record file (ADR-184), so the stored path wins over the one the lineage
   * would derive; the derived one is for a record the registry has not seen.
   */
  knownPath?: string | null,
): Promise<RecordFileRead | null> {
  const path = knownPath ?? recordFilePath(lineageId);
  try {
    const repo = await github.resolveRepository(scope);
    const text = await github.readFile(repo, path, repo.defaultBranch);
    if (text === null) return null;
    const file = readRecordFile(text);
    if (!file) {
      logger.warn(
        { lineageId, path, repository: repo.fullName },
        "[context.record] record file did not parse as context-record/v0.1",
      );
      return null;
    }
    const commit = await github
      .lastCommitForPath(repo, path, repo.defaultBranch)
      .catch((err: unknown) => {
        // A record with no provenance still renders; a record that 500s does
        // not. The provenance block says "not recorded" and this line says
        // why, which is the pair that lets an operator tell a repository
        // without history from a token that lost `contents: read`.
        logger.warn(
          { lineageId, path, err },
          "[context.record] could not read the publishing commit",
        );
        return null;
      });
    return {
      file,
      path,
      repository: repo.fullName,
      ref: repo.defaultBranch,
      commit,
    };
  } catch (err) {
    // `workspace_repository_missing` is the expected answer for a workspace
    // that has not bound a main repository yet, and is not worth a log line
    // on every read of every record.
    if (
      !(err instanceof HandlerError) ||
      err.reason !== "workspace_repository_missing"
    ) {
      logger.warn(
        { lineageId, path, err },
        "[context.record] repository read failed; answering from the registry mirror",
      );
    }
    return null;
  }
}

/** What the registry mirror holds for one record: the row, its versions and its publication. */
export type MirroredRecord = NonNullable<
  Awaited<ReturnType<SteeringStore["findRecord"]>>
>;

/** The one shape every record read refuses an unknown id with. */
export function recordNotFound(id: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "record_not_found",
    message: `No record ${id} in this workspace`,
  });
}

/**
 * Whether `id` can be a lineage: the file stem under `.oxagen/rules/`, as the
 * proposal contract spells it. A `ctr_` id fails this by construction.
 */
function isLineageId(id: string): boolean {
  return lineageIdSchema.safeParse(id).success;
}

/**
 * The record an id names, from the mirror and from the file.
 *
 * A `ctr_` id can only reach a file through the mirror, which knows the
 * record's lineage and where its file was last seen. Anything that is a valid
 * lineage reaches the file directly, which is what lets a record whose mirror
 * row is gone still be read back. An id that is neither reaches nothing: the
 * lineage is spliced into the file path, and only the proposal contract's
 * lineage shape may go there.
 *
 * Refuses `record_not_found` when neither the mirror nor the production
 * branch holds the record.
 */
export async function resolveRecordById(
  deps: { store: Pick<SteeringStore, "findRecord">; github: SteeringGitHub },
  scope: { orgId: string; workspaceId: string },
  recordId: string,
): Promise<{
  mirrored: MirroredRecord | null;
  lineageId: string | null;
  fileRead: RecordFileRead | null;
}> {
  const mirrored = await deps.store.findRecord(scope, recordId);
  const lineageId =
    mirrored?.record.slug ?? (isLineageId(recordId) ? recordId : null);
  const fileRead = lineageId
    ? await readRecordFromRepo(
        deps.github,
        scope,
        lineageId,
        isRepositoryRecord(mirrored?.record.path ?? null)
          ? mirrored!.record.path
          : null,
      )
    : null;
  if (!mirrored && !fileRead) throw recordNotFound(recordId);
  return { mirrored, lineageId, fileRead };
}
