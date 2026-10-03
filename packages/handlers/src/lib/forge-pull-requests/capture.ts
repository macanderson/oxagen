// Read a head commit's diff from its forge and put it in the diff store
// (ADR-288).
//
// The diff is the forge's own three-dot compare: from the merge base of the
// base branch and the head, to the head. It is what the forge's "Files
// changed" view shows, and it does not move when the base branch does. It is
// read by commit id, never as "the pull request's current diff", so a push
// that lands while this runs cannot put another head's bytes under this
// head's key.
//
// The bytes are kept as the forge sent them. Their sha256 is computed over
// those bytes and checked by S3 on the put, so the digest on the revision row
// is the digest of the object a reader gets back.
import { createGitHubClient, GitHubApiError } from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import { createGitLabClient, GitLabApiError } from "@oxagen/gitlab";
import type {
  ForgeCapturedFile,
  ForgePullRequestCapture,
  ForgePullRequestSyncRequest,
  ForgePullRequestUpsert,
} from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import { sha256Hex } from "@oxagen/storage/s3";
import { findWorkspaceGitLabConnection } from "../../repository.gitlab-connection";
import { resolveGitLabCredential } from "../gitlab-credential";
import { githubConnectionFor } from "../run-pull-request-backfill";
import type { DiffStore } from "./diff-store";
import { diffKeyOf } from "./facts";
import type { Scope } from "./store";

type Target = NonNullable<ForgePullRequestUpsert["target"]>;

/** The largest diff kept. A larger one is recorded as `too_large`. */
export const DIFF_MAX_BYTES = 32 * 1024 * 1024;

/** What the forge answered: the bytes, too large, or not readable. */
export type ForgeDiffRead =
  | {
      kind: "diff";
      bytes: Uint8Array;
      mergeBaseSha: string | null;
      files: ForgeCapturedFile[];
      limitations: string[];
    }
  | {
      kind: "too_large" | "unreadable" | "files_only";
      mergeBaseSha: string | null;
      files: ForgeCapturedFile[];
      limitations: string[];
    };

/** 403, 404 and 410: the workspace's credentials cannot read it. */
function unreadable(status: number): boolean {
  return status === 403 || status === 404 || status === 410;
}

function totals(files: readonly ForgeCapturedFile[]) {
  let additions = 0;
  let deletions = 0;
  let counted = true;
  for (const file of files) {
    if (file.additions === null || file.deletions === null) counted = false;
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return counted
    ? { filesChanged: files.length, additions, deletions }
    : { filesChanged: files.length, additions: null, deletions: null };
}

/**
 * Read the diff from GitHub with the workspace's own connection. With no
 * store to keep it in, only the file list is read.
 */
export async function readGithubDiff(
  scope: Scope,
  request: ForgePullRequestSyncRequest,
  target: Target,
  wantBytes: boolean,
): Promise<ForgeDiffRead | "no_connection"> {
  const [owner = "", repo = ""] = request.repository.split("/");
  const connectionId = await githubConnectionFor(scope, owner);
  if (connectionId === null) return "no_connection";
  const client = createGitHubClient({
    token: await resolveGitHubToken({ ...scope, connectionId }),
  });
  const base = target.baseSha ?? target.baseRef;
  if (base === null)
    return {
      kind: "unreadable",
      mergeBaseSha: null,
      files: [],
      limitations: ["no_base"],
    };
  const args = { owner, repo, base, head: target.headSha };
  try {
    const refs = await client.compareRefs(args);
    const files: ForgeCapturedFile[] = refs.files.map((file) => ({
      path: file.path,
      ...(file.previousPath === null ? {} : { previousPath: file.previousPath }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
    const limitations = refs.filesTruncated ? ["files_truncated"] : [];
    if (!wantBytes)
      return {
        kind: "files_only",
        mergeBaseSha: refs.mergeBaseSha,
        files,
        limitations,
      };
    const diff = await client.getCompareDiff({
      ...args,
      maxBytes: DIFF_MAX_BYTES,
    });
    return diff.status === "ok"
      ? {
          kind: "diff",
          bytes: diff.bytes,
          mergeBaseSha: refs.mergeBaseSha,
          files,
          limitations,
        }
      : {
          kind: "too_large",
          mergeBaseSha: refs.mergeBaseSha,
          files,
          limitations: [...limitations, `diff_${diff.reason}`],
        };
  } catch (err) {
    if (err instanceof GitHubApiError && unreadable(err.status))
      return {
        kind: "unreadable",
        mergeBaseSha: null,
        files: [],
        limitations: [`forge_${err.status}`],
      };
    throw err;
  }
}

/** Read the diff from GitLab with the workspace's connection to the project. */
export async function readGitlabDiff(
  scope: Scope,
  request: ForgePullRequestSyncRequest,
  target: Target,
  wantBytes: boolean,
): Promise<ForgeDiffRead | "no_connection"> {
  const connection = await findWorkspaceGitLabConnection(scope, {
    path: request.repository,
  });
  if (connection === null || connection.status !== "connected")
    return "no_connection";
  const credential = await resolveGitLabCredential({
    ...scope,
    connectionId: connection.id,
  });
  const client = createGitLabClient({ token: credential.token });
  const from = target.mergeBaseSha ?? target.baseSha ?? target.baseRef;
  if (from === null)
    return {
      kind: "unreadable",
      mergeBaseSha: null,
      files: [],
      limitations: ["no_base"],
    };
  try {
    const compare = await client.compareDiff({
      project: connection.config.projectId,
      from,
      to: target.headSha,
    });
    const files: ForgeCapturedFile[] = compare.files;
    if (!wantBytes)
      return {
        kind: "files_only",
        mergeBaseSha: target.mergeBaseSha,
        files,
        limitations: compare.limitations,
      };
    const bytes = new TextEncoder().encode(compare.text);
    return bytes.byteLength > DIFF_MAX_BYTES
      ? {
          kind: "too_large",
          mergeBaseSha: target.mergeBaseSha,
          files,
          limitations: [...compare.limitations, "diff_over_cap"],
        }
      : {
          kind: "diff",
          bytes,
          mergeBaseSha: target.mergeBaseSha,
          files,
          limitations: compare.limitations,
        };
  } catch (err) {
    if (err instanceof GitLabApiError && unreadable(err.status))
      return {
        kind: "unreadable",
        mergeBaseSha: null,
        files: [],
        limitations: [`forge_${err.status}`],
      };
    throw err;
  }
}

/**
 * Turn a forge read into the revision a record step writes, putting the
 * bytes in the store first. A read with no connection is `unreadable`: the
 * pull request row came from a delivery, but no connection this workspace
 * holds can read the diff.
 */
export async function captureFrom(
  scope: Scope,
  request: ForgePullRequestSyncRequest,
  target: Target,
  read: ForgeDiffRead | "no_connection",
  store: DiffStore | null,
): Promise<ForgePullRequestCapture> {
  const none = {
    diffStore: null,
    diffKey: null,
    diffSha256: null,
    diffBytes: null,
  };
  if (read === "no_connection")
    return {
      diffStatus: "unreadable",
      ...none,
      mergeBaseSha: null,
      files: [],
      filesChanged: null,
      additions: null,
      deletions: null,
      complete: false,
      limitations: ["no_connection"],
    };
  const counts = totals(read.files);
  if (read.kind !== "diff" || store === null)
    return {
      diffStatus:
        read.kind === "diff" || read.kind === "files_only"
          ? "unconfigured"
          : read.kind,
      ...none,
      mergeBaseSha: read.mergeBaseSha,
      files: read.files,
      ...counts,
      complete: false,
      limitations: read.limitations,
    };
  const sha256 = sha256Hex(read.bytes);
  const key = diffKeyOf({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    provider: request.provider,
    providerRepositoryId: target.providerRepositoryId,
    number: target.number,
    headSha: target.headSha,
  });
  await store.putOnce(key, read.bytes, {
    sha256,
    contentType: "text/x-diff; charset=utf-8",
  });
  return {
    diffStatus: "stored",
    diffStore: store.name,
    diffKey: key,
    diffSha256: sha256,
    diffBytes: read.bytes.byteLength,
    mergeBaseSha: read.mergeBaseSha,
    files: read.files,
    ...counts,
    complete: read.limitations.length === 0,
    limitations: read.limitations,
  };
}
