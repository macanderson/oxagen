// audit-exempt: read-only — reads one pull request revision's diff from the diff store; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// get_revision_diff (ADR-292): one revision's diff, split into files. The
// bytes come from the diff store, and their sha256 is checked against the one
// the revision recorded before anything is answered: a mismatch is an error,
// never a diff. A revision whose bytes are not kept answers its file list
// with no hunks, and `diffStatus` says why.
import { withTenantDb } from "@oxagen/database";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  REVISION_DIFF_MAX_CHARS,
  REVISION_DIFF_MAX_FILE_CHARS,
  type RevisionDiffGetOutput,
  revisionDiffGet,
} from "@oxagen/oxagen/contracts/forge.revision.diff.get";
import { type DiffStore, diffStore } from "./lib/forge-pull-requests/diff-store";
import { readRevision } from "./lib/forge-pull-requests/read";
import {
  readRevisionFiles,
  type RevisionFilesFailure,
} from "./lib/forge-pull-requests/revision-files";

type Scope = { orgId: string; workspaceId: string };
type Read = NonNullable<Awaited<ReturnType<typeof readRevision>>>;

export type RevisionDiffGetDeps = {
  revision(scope: Scope, publicId: string): Promise<Read | null>;
  store(): DiffStore | null;
};

/** The refusal each failed read of the stored bytes answers. */
function refusal(reason: RevisionFilesFailure, revisionId: string): HandlerError {
  switch (reason) {
    case "diff_store_unconfigured":
      return new HandlerError({
        code: "conflict",
        reason,
        message:
          "This deployment names no diff store, so the stored diff cannot be read.",
      });
    case "diff_missing":
      return new HandlerError({
        code: "not_found",
        reason,
        message: `The diff for revision ${revisionId} is not in the diff store.`,
      });
    case "diff_digest_mismatch":
      return new HandlerError({
        code: "conflict",
        reason,
        message: `The stored diff for revision ${revisionId} does not match the digest recorded when it was captured.`,
      });
  }
}

export function createGetRevisionDiffHandler(
  deps: RevisionDiffGetDeps,
): CapabilityHandler<typeof revisionDiffGet> {
  return async (input, ctx) => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const read = await deps.revision(scope, input.revisionId);
    if (read === null)
      throw new HandlerError({
        code: "not_found",
        reason: "revision_not_found",
        message: `No pull request revision ${input.revisionId} in this workspace`,
      });
    const { revision } = read;
    const files = await readRevisionFiles(
      revision,
      deps.store(),
      {
        maxChars: REVISION_DIFF_MAX_CHARS,
        maxFileChars: REVISION_DIFF_MAX_FILE_CHARS,
      },
      input.paths === undefined ? null : new Set(input.paths),
    );
    if (!files.ok) throw refusal(files.reason, input.revisionId);
    return {
      revisionId: String(revision.publicId),
      pullRequestId: read.pullRequestPublicId,
      headSha: revision.headSha,
      mergeBaseSha: revision.mergeBaseSha,
      diffStatus: revision.diffStatus as RevisionDiffGetOutput["diffStatus"],
      complete: revision.complete,
      limitations: revision.limitations,
      diffSha256: files.diffSha256,
      files: files.files,
      truncated: files.truncated,
    };
  };
}

export const getRevisionDiffHandler = createGetRevisionDiffHandler({
  revision: (scope, publicId) =>
    withTenantDb((tx) => readRevision(tx, scope, publicId)),
  store: diffStore,
});
