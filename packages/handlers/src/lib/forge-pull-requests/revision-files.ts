// One revision's files with their hunks, read from the diff store (ADR-292).
//
// `get_revision_diff` and `get_run_work` both answer a pull request's files
// from the stored bytes, so both read them here. The bytes' sha256 is checked
// against the one the revision recorded before any hunk is answered: a
// mismatch is a failure, never a diff. A revision whose bytes are not kept
// (`too_large`, `unreadable`, `unconfigured`) answers its file list with no
// hunks.
//
// A failure is answered as a reason, not thrown, because the two readers
// treat it differently: `get_revision_diff` refuses the call, and
// `get_run_work` keeps the file list and names the reason.
import type { schema } from "@oxagen/database";
import { sha256Hex } from "@oxagen/storage/s3";
import { capHunks, splitUnifiedDiff } from "./diff-split";
import type { DiffStore } from "./diff-store";

type RevisionRow = typeof schema.forgePullRequestRevisions.$inferSelect;

/** The columns a read of a revision's files needs. */
export type RevisionForFiles = Pick<
  RevisionRow,
  "diffStatus" | "diffKey" | "diffSha256" | "files"
>;

/** One file of a revision, with its hunks where the stored bytes hold them. */
export type RevisionFile = {
  path: string;
  /** The path before a rename or copy; absent when the file kept its path. */
  previousPath?: string;
  status: RevisionRow["files"][number]["status"];
  additions: number | null;
  deletions: number | null;
  /**
   * The file's hunks from its first `@@` line. Null when the bytes are not
   * kept, the file is binary, or the budget was spent before it.
   */
  patch: string | null;
  binary: boolean;
  /** True when the file's hunks were cut at its cap. */
  truncated: boolean;
};

/** Why the stored bytes could not be read. */
export type RevisionFilesFailure =
  | "diff_store_unconfigured"
  | "diff_missing"
  | "diff_digest_mismatch";

export type RevisionFilesRead =
  | {
      ok: true;
      /** The sha256 the stored bytes matched; null when none are stored. */
      diffSha256: string | null;
      files: RevisionFile[];
      /** True when the total budget left later files without hunks. */
      truncated: boolean;
    }
  | { ok: false; reason: RevisionFilesFailure };

/** The hunk budgets of one read, in UTF-16 code units. */
export type RevisionFilesBudget = {
  /** The most hunk text the whole answer carries. */
  maxChars: number;
  /** The most hunk text one file carries before it is cut. */
  maxFileChars: number;
};

/** The revision's file list with no hunks: what a revision without bytes answers. */
export function manifestFiles(
  revision: Pick<RevisionRow, "files">,
  wanted: ReadonlySet<string> | null = null,
): RevisionFile[] {
  return revision.files
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

/**
 * A revision's files with their hunks, from the stored bytes when it has
 * them and from its file list when it does not. `wanted` keeps only those
 * paths; null keeps every file.
 */
export async function readRevisionFiles(
  revision: RevisionForFiles,
  store: DiffStore | null,
  budget: RevisionFilesBudget,
  wanted: ReadonlySet<string> | null = null,
): Promise<RevisionFilesRead> {
  const key = revision.diffStatus === "stored" ? revision.diffKey : null;
  if (key === null)
    return {
      ok: true,
      diffSha256: null,
      files: manifestFiles(revision, wanted),
      truncated: false,
    };
  if (store === null) return { ok: false, reason: "diff_store_unconfigured" };
  const bytes = await store.get(key);
  if (bytes === null) return { ok: false, reason: "diff_missing" };
  if (sha256Hex(bytes) !== revision.diffSha256)
    return { ok: false, reason: "diff_digest_mismatch" };
  const counts = new Map(
    revision.files.map((file) => [file.path, file] as const),
  );
  let remaining = budget.maxChars;
  let truncated = false;
  const files: RevisionFile[] = [];
  for (const part of splitUnifiedDiff(new TextDecoder().decode(bytes))) {
    if (wanted !== null && !wanted.has(part.path)) continue;
    const known = counts.get(part.path);
    const base: Omit<RevisionFile, "patch" | "truncated"> = {
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
    if (remaining <= 0) {
      truncated = true;
      files.push({ ...base, patch: null, truncated: false });
      continue;
    }
    const capped = capHunks(
      part.hunks,
      Math.min(budget.maxFileChars, remaining),
    );
    remaining -= capped.text.length;
    files.push({ ...base, patch: capped.text, truncated: capped.truncated });
  }
  return { ok: true, diffSha256: revision.diffSha256, files, truncated };
}
