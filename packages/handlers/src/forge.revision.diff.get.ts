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
import { sha256Hex } from "@oxagen/storage/s3";
import { capHunks, splitUnifiedDiff } from "./lib/forge-pull-requests/diff-split";
import { type DiffStore, diffStore } from "./lib/forge-pull-requests/diff-store";
import { readRevision } from "./lib/forge-pull-requests/read";

type Scope = { orgId: string; workspaceId: string };
type Read = NonNullable<Awaited<ReturnType<typeof readRevision>>>;

export type RevisionDiffGetDeps = {
  revision(scope: Scope, publicId: string): Promise<Read | null>;
  store(): DiffStore | null;
};

type FileOut = RevisionDiffGetOutput["files"][number];

/** The revision's file list with no hunks: what a revision without bytes answers. */
function manifestFiles(
  revision: Read["revision"],
  wanted: Set<string> | null,
): FileOut[] {
  return (revision.files ?? [])
    .filter((file) => wanted === null || wanted.has(file.path))
    .map((file) => ({
      path: file.path,
      ...(file.previousPath === undefined
        ? {}
        : { previousPath: file.previousPath }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: null,
      binary: false,
      truncated: false,
    }));
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
    const wanted = input.paths === undefined ? null : new Set(input.paths);
    const head = {
      revisionId: String(revision.publicId),
      pullRequestId: read.pullRequestPublicId,
      headSha: revision.headSha,
      mergeBaseSha: revision.mergeBaseSha,
      diffStatus: revision.diffStatus as RevisionDiffGetOutput["diffStatus"],
      complete: revision.complete,
      limitations: revision.limitations,
    };
    if (revision.diffStatus !== "stored" || revision.diffKey === null)
      return {
        ...head,
        diffSha256: null,
        files: manifestFiles(revision, wanted),
        truncated: false,
      };
    const store = deps.store();
    if (store === null)
      throw new HandlerError({
        code: "conflict",
        reason: "diff_store_unconfigured",
        message:
          "This deployment names no diff store, so the stored diff cannot be read.",
      });
    const bytes = await store.get(revision.diffKey);
    if (bytes === null)
      throw new HandlerError({
        code: "not_found",
        reason: "diff_missing",
        message: `The diff for revision ${input.revisionId} is not in the diff store.`,
      });
    if (sha256Hex(bytes) !== revision.diffSha256)
      throw new HandlerError({
        code: "conflict",
        reason: "diff_digest_mismatch",
        message: `The stored diff for revision ${input.revisionId} does not match the digest recorded when it was captured.`,
      });
    const counts = new Map(
      (revision.files ?? []).map((file) => [file.path, file] as const),
    );
    let budget = REVISION_DIFF_MAX_CHARS;
    let truncated = false;
    const files: FileOut[] = [];
    for (const part of splitUnifiedDiff(new TextDecoder().decode(bytes))) {
      if (wanted !== null && !wanted.has(part.path)) continue;
      const known = counts.get(part.path);
      const base: Omit<FileOut, "patch" | "truncated"> = {
        path: part.path,
        ...(part.previousPath === undefined
          ? {}
          : { previousPath: part.previousPath }),
        status:
          known?.status ??
          (part.previousPath === undefined ? "modified" : "renamed"),
        additions: known?.additions ?? null,
        deletions: known?.deletions ?? null,
        binary: part.binary,
      };
      if (part.binary || part.hunks === "") {
        files.push({ ...base, patch: null, truncated: false });
        continue;
      }
      if (budget <= 0) {
        truncated = true;
        files.push({ ...base, patch: null, truncated: false });
        continue;
      }
      const capped = capHunks(
        part.hunks,
        Math.min(REVISION_DIFF_MAX_FILE_CHARS, budget),
      );
      budget -= capped.text.length;
      files.push({ ...base, patch: capped.text, truncated: capped.truncated });
    }
    return { ...head, diffSha256: revision.diffSha256, files, truncated };
  };
}

export const getRevisionDiffHandler = createGetRevisionDiffHandler({
  revision: (scope, publicId) =>
    withTenantDb((tx) => readRevision(tx, scope, publicId)),
  store: diffStore,
});
