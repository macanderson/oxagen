// context.record.source.ts — where a published record is read back from
// (ADR-061; MC spec §10.2).
//
// The record is the file. `.oxagen/rules/<lineage>.toml` on the workspace's
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
import type { SteeringGitHub } from "./context.steering.github";
import {
  type ParsedRecordFile,
  readRecordFile,
  recordFilePath,
} from "./context.steering.file";
import { logger } from "./logger";

export interface RecordFileRead {
  /** The record as its file spells it. */
  file: ParsedRecordFile;
  /** `.oxagen/rules/<lineage>.toml`. */
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
): Promise<RecordFileRead | null> {
  const path = recordFilePath(lineageId);
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
